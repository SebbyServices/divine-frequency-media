#!/usr/bin/env node
// post-due.mjs — runs inside GitHub Actions every 10 minutes.
// Reads schedule.json, posts anything due, cleans up used videos.

import fs from 'fs';

const IG_USER_ID   = process.env.INSTAGRAM_USER_ID;
const IG_TOKEN     = process.env.INSTAGRAM_ACCESS_TOKEN;
const TH_USER_ID   = process.env.THREADS_USER_ID;
const TH_TOKEN     = process.env.THREADS_ACCESS_TOKEN;
const GH_TOKEN     = process.env.GITHUB_TOKEN;

const GITHUB_USER  = 'SebbyServices';
const MEDIA_REPO   = 'divine-frequency-media';
const IG_BASE      = 'https://graph.facebook.com/v21.0';
const TH_BASE      = 'https://graph.threads.net/v1.0';

// ─── Load / save schedule ─────────────────────────────────────────────────────

const SCHEDULE_FILE = 'schedule.json';

function loadSchedule() {
  if (!fs.existsSync(SCHEDULE_FILE)) return [];
  return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
}

function saveSchedule(entries) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(entries, null, 2));
}

// ─── GitHub API: delete a file from this repo ────────────────────────────────

async function deleteMediaFile(filename) {
  const url = `https://api.github.com/repos/${GITHUB_USER}/${MEDIA_REPO}/contents/${encodeURIComponent(filename)}`;
  const headers = { Authorization: `token ${GH_TOKEN}`, Accept: 'application/vnd.github.v3+json' };

  const getRes = await fetch(url, { headers });
  if (getRes.status === 404) { console.log(`   Not found, skipping delete: ${filename}`); return; }
  if (!getRes.ok) { console.warn(`   GitHub API error ${getRes.status} for ${filename}`); return; }

  const { sha } = await getRes.json();

  const delRes = await fetch(url, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Remove used media: ${filename}`, sha }),
  });

  if (delRes.ok) {
    console.log(`🗑️  Deleted from media repo: ${filename}`);
  } else {
    const err = await delRes.json();
    console.warn(`   Failed to delete ${filename}: ${JSON.stringify(err.message ?? err)}`);
  }
}

// ─── Instagram ────────────────────────────────────────────────────────────────

async function postInstagram(entry) {
  console.log(`\n📸 Instagram: ${entry.id}`);

  // Step 1: Create container
  const containerParams = new URLSearchParams({
    media_type:    'REELS',
    video_url:     entry.videoUrl,
    caption:       entry.caption,
    share_to_feed: 'true',
    access_token:  IG_TOKEN,
  });
  const containerRes  = await fetch(`${IG_BASE}/${IG_USER_ID}/media`, { method: 'POST', body: containerParams });
  const containerData = await containerRes.json();
  if (containerData.error) throw new Error(`IG container failed: ${JSON.stringify(containerData.error)}`);
  const containerId = containerData.id;
  console.log(`   Container ID: ${containerId}`);

  // Step 2: Poll until processed (max 6 min)
  console.log('   Waiting for processing...');
  for (let i = 0; i < 36; i++) {
    await new Promise(r => setTimeout(r, 10_000));
    const statusRes  = await fetch(`${IG_BASE}/${containerId}?fields=status_code&access_token=${IG_TOKEN}`);
    const statusData = await statusRes.json();
    console.log(`   Status: ${statusData.status_code}`);
    if (statusData.status_code === 'FINISHED') break;
    if (statusData.status_code === 'ERROR')    throw new Error('Instagram video processing failed');
    if (i === 35) throw new Error('Timed out waiting for Instagram processing');
  }

  // Step 3: Publish
  const publishParams = new URLSearchParams({ creation_id: containerId, access_token: IG_TOKEN });
  const publishRes  = await fetch(`${IG_BASE}/${IG_USER_ID}/media_publish`, { method: 'POST', body: publishParams });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`IG publish failed: ${JSON.stringify(publishData.error)}`);

  console.log(`   ✅ Published! Media ID: ${publishData.id}`);
  return publishData.id;
}

// ─── Threads ──────────────────────────────────────────────────────────────────

async function postThreads(entry) {
  console.log(`\n🧵 Threads: ${entry.id}`);

  // Step 1: Create text container
  const containerParams = new URLSearchParams({
    media_type:   'TEXT',
    text:         entry.text,
    access_token: TH_TOKEN,
  });
  const containerRes  = await fetch(`${TH_BASE}/${TH_USER_ID}/threads`, { method: 'POST', body: containerParams });
  const containerData = await containerRes.json();
  if (containerData.error) throw new Error(`Threads container failed: ${JSON.stringify(containerData.error)}`);
  const containerId = containerData.id;
  console.log(`   Container ID: ${containerId}`);

  // Small delay before publishing
  await new Promise(r => setTimeout(r, 3_000));

  // Step 2: Publish
  const publishParams = new URLSearchParams({ creation_id: containerId, access_token: TH_TOKEN });
  const publishRes  = await fetch(`${TH_BASE}/${TH_USER_ID}/threads_publish`, { method: 'POST', body: publishParams });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`Threads publish failed: ${JSON.stringify(publishData.error)}`);

  console.log(`   ✅ Published! Media ID: ${publishData.id}`);
  return publishData.id;
}

// ─── Cleanup: delete video if all platforms done ─────────────────────────────

async function cleanupVideoIfDone(filename, allEntries) {
  const relevant = allEntries.filter(e => e.videoFilename === filename);
  const allDone  = relevant.every(e => e.status === 'done' || e.status === 'failed');
  if (allDone) {
    console.log(`\n🧹 All platforms done for ${filename} — deleting from media repo...`);
    await deleteMediaFile(filename);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const entries = loadSchedule();
  const now     = new Date();

  const due = entries.filter(e => e.status === 'pending' && new Date(e.scheduledAt) <= now);

  if (!due.length) {
    console.log(`✅ No posts due at ${now.toISOString()}`);
    return;
  }

  console.log(`\n📅 ${due.length} post(s) due at ${now.toISOString()}`);

  for (const entry of due) {
    try {
      let mediaId;
      if      (entry.platform === 'instagram') mediaId = await postInstagram(entry);
      else if (entry.platform === 'threads')   mediaId = await postThreads(entry);

      entry.status   = 'done';
      entry.postedAt = new Date().toISOString();
      entry.mediaId  = mediaId;
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}`);
      entry.status = 'failed';
      entry.error  = err.message;
    }

    // Save after each post so progress isn't lost if the job times out
    saveSchedule(entries);

    // Attempt cleanup after each successful post
    if (entry.status === 'done') {
      await cleanupVideoIfDone(entry.videoFilename, entries);
    }
  }

  console.log('\n✅ Run complete.');
}

main().catch(err => {
  console.error('❌ Fatal:', err.message);
  process.exit(1);
});
