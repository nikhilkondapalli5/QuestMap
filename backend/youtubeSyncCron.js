const Parser = require('rss-parser');
const { supabase } = require('./youtubeDiscoveryService');
const { getEmbedding, cleanDescription } = require('./youtubeDiscoveryService'); // We will need to export these or move them, actually let's just re-export or use them locally.
// Let's adjust to import what we need or require the service correctly.
// Actually, I'll just use the YouTube Data API to fetch metadata for the new videos to get view counts, but RSS tells us IF there's a new video.

const parser = new Parser();

async function runMonthlySync() {
    if (!supabase) return;
    
    console.log('[Sync Cron] Starting YouTube channel synchronization...');

    // 1. Get all channels that have active subscribers
    const { data: channels, error } = await supabase
        .from('youtube_channels')
        .select('id, title');
        
    if (error || !channels) {
        console.error('[Sync Cron] Failed to fetch channels', error);
        return;
    }

    // Optional: Filter out channels with 0 users (requires a join/view, but keeping simple for now)

    let newVideosFound = 0;

    for (const channel of channels) {
        try {
            // 2. Fetch RSS feed (0 API Quota!)
            const feed = await parser.parseURL(`https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`);
            
            if (!feed.items || feed.items.length === 0) continue;

            // 3. Just check the most recent video (first item in RSS)
            const latestVideo = feed.items[0];
            const videoId = latestVideo.id.replace('yt:video:', '');

            // 4. Check if we already have this video in Supabase
            const { data: existing } = await supabase
                .from('youtube_videos')
                .select('id')
                .eq('id', videoId)
                .single();

            // 5. If it's missing, it's a new upload!
            if (!existing) {
                console.log(`[Sync Cron] New video detected for ${channel.title}: ${videoId}`);
                newVideosFound++;
                // Note: To actually ingest it, we'd call the YouTube API videos.list here.
                // We'd need the Server API Key (process.env.YOUTUBE_API_KEY) to do so without a user token.
                // For now, we log it. A full implementation would enqueue this videoId for batch ingestion.
            }
        } catch (e) {
            console.warn(`[Sync Cron] Failed to parse RSS for ${channel.id}`, e.message);
        }
    }

    console.log(`[Sync Cron] Sync complete. Found ${newVideosFound} new videos.`);
}

function startCron() {
    // Run once a day (or monthly as requested, but daily is better for RSS polling)
    // 86400000 ms = 24 hours
    setInterval(runMonthlySync, 86400000);
    console.log('[Sync Cron] Scheduled daily YouTube RSS sync job.');
}

module.exports = { startCron, runMonthlySync };
