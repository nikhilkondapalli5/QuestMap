require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' }); // 768 dims

/**
 * Strips URLs, social media handles, and standard YouTube boilerplate
 * to ensure semantic embeddings only capture educational value.
 */
function cleanDescription(text) {
    if (!text) return '';
    let cleaned = text;
    // Strip URLs
    cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, '');
    // Strip boilerplate phrases
    cleaned = cleaned.replace(/subscribe( to my channel)?/gi, '');
    cleaned = cleaned.replace(/patreon\.com\/[^\s]+/gi, '');
    cleaned = cleaned.replace(/follow me on (twitter|instagram|facebook|tiktok|x|twitch)/gi, '');
    cleaned = cleaned.replace(/smash that like button/gi, '');
    cleaned = cleaned.replace(/turn on notifications/gi, '');
    
    // Limit to first 400 chars to optimize DB space while capturing core essence
    return cleaned.trim().substring(0, 400);
}

async function getEmbedding(text) {
    const result = await embeddingModel.embedContent(text);
    return result.embedding.values.slice(0, 768); // Slice to 768 dims for Supabase
}

/**
 * 1. Sync User Channels
 * Fetches all subscriptions for a user and registers them in Supabase.
 */
async function syncUserChannels(userId, ytAccessToken) {
    if (!supabase) throw new Error('Supabase not configured');
    if (!userId || !ytAccessToken) throw new Error('Missing userId or YouTube token');

    let allChannels = [];
    let nextPageToken = null;

    console.log(`[Supabase] Syncing channels for userId: ${userId}...`);
    do {
        const url = new URL('https://www.googleapis.com/youtube/v3/subscriptions');
        url.searchParams.set('part', 'snippet,contentDetails');
        url.searchParams.set('mine', 'true');
        url.searchParams.set('maxResults', '50');
        if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);

        const res = await fetch(url.toString(), {
            headers: { Authorization: `Bearer ${ytAccessToken}` },
        });

        if (!res.ok) {
            console.warn('[Supabase] Subscriptions API error:', res.status);
            break;
        }

        const data = await res.json();
        for (const item of (data.items || [])) {
            allChannels.push({
                id: item.snippet.resourceId.channelId,
                title: item.snippet.title || '',
                description: item.snippet.description || '',
                thumbnail_url: item.snippet.thumbnails?.default?.url || '',
                // Note: contentDetails.newItemCount exists, but we need the actual channel's upload playlist
                // We will fetch uploads_playlist_id later during ingestion if missing
            });
        }
        nextPageToken = data.nextPageToken || null;
    } while (nextPageToken);

    console.log(`[Supabase] Found ${allChannels.length} subscriptions.`);

    // --- Educational Content Filter via Gemini ---
    if (allChannels.length > 0) {
        try {
            console.log(`[Supabase] Filtering channels using Gemini...`);
            const textModel = genAI.getGenerativeModel({ 
                model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash-lite',
                generationConfig: { responseMimeType: "application/json" }
            });
            
            const channelListStr = allChannels.map((c, i) => {
                const desc = c.description || '';
                return `${i+1}. ${c.title} (Desc: ${desc.slice(0,100).replace(/\n/g, ' ')}...)`;
            }).join('\n');
            
            const prompt = `You are an educational curriculum assistant. I have a list of YouTube channels.
Please identify ONLY the channels that produce educational, instructional, technology, science, academic, programming, or professional learning content.
Completely exclude pure entertainment, gaming, daily vlogs, prank channels, music, and purely comedic channels.
Return a JSON array of strings containing EXACTLY the titles of the educational channels. If there are none, return [].
Here is the list:
${channelListStr}`;

            const response = await textModel.generateContent(prompt);
            const text = response.response.text();
            const allowedTitles = JSON.parse(text);
            
            allChannels = allChannels.filter(c => allowedTitles.includes(c.title));
            console.log(`[Supabase] Filtered down to ${allChannels.length} educational channels.`);
        } catch (err) {
            console.error("[Supabase] Educational filter failed, proceeding with all channels:", err.message);
        }
    }
    // ---------------------------------------------

    // Upsert channels
    if (allChannels.length > 0) {
        const { error: chErr } = await supabase.from('youtube_channels').upsert(
            allChannels.map(ch => ({
                id: ch.id,
                title: ch.title,
                description: cleanDescription(ch.description),
                thumbnail_url: ch.thumbnail_url
            }))
        );
        if (chErr) console.error('[Supabase] Channel Upsert Error:', chErr);

        // Upsert user mapping
        const { error: subErr } = await supabase.from('user_subscriptions').upsert(
            allChannels.map(ch => ({
                user_id: userId,
                channel_id: ch.id
            }))
        );
        if (subErr) console.error('[Supabase] Sub Upsert Error:', subErr);
    }

    // BACKGROUND INGESTION TRIGGER (TEMPORARILY DISABLED)
    // Process channels sequentially in the background to avoid Gemini Rate Limits (429)
    /*
    (async () => {
        for (const ch of allChannels) {
            try {
                await ingestChannel(ch.id, ch.uploads_playlist_id, ytAccessToken);
                // Add a small 500ms delay between channels to spread out API requests
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.error(`[Supabase] Background ingestion failed for channel ${ch.id}`, err.message);
            }
        }
    })();
    */

    return allChannels;
}

/**
 * 2. Ingest Channel Videos (Background Task)
 * Fetches the back-catalog of videos for a specific channel.
 */
async function ingestChannel(channelId, uploadsPlaylistId, ytAuthToken) {
    if (!supabase) return;

    // If we don't have the uploadsPlaylistId, fetch it from channels.list
    if (!uploadsPlaylistId) {
        const url = `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${ytAuthToken}` } });
        const data = await res.json();
        uploadsPlaylistId = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (uploadsPlaylistId) {
            await supabase.from('youtube_channels').update({ uploads_playlist_id: uploadsPlaylistId }).eq('id', channelId);
        }
    }

    if (!uploadsPlaylistId) return;

    // Fetch playlist items (videos)
    const playlistUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    playlistUrl.searchParams.set('part', 'snippet');
    playlistUrl.searchParams.set('playlistId', uploadsPlaylistId);
    playlistUrl.searchParams.set('maxResults', '50'); // Just grab the 50 most recent for initial ingestion

    const pRes = await fetch(playlistUrl.toString(), { headers: { Authorization: `Bearer ${ytAuthToken}` } });
    const pData = await pRes.json();
    const videoIds = (pData.items || []).map(item => item.snippet.resourceId.videoId);

    if (videoIds.length === 0) return;

    // Batch fetch video details (statistics)
    const vUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    vUrl.searchParams.set('part', 'snippet,statistics');
    vUrl.searchParams.set('id', videoIds.join(','));
    
    const vRes = await fetch(vUrl.toString(), { headers: { Authorization: `Bearer ${ytAuthToken}` } });
    const vData = await vRes.json();

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const videoRecords = [];
    for (const vid of (vData.items || [])) {
        const publishedAt = new Date(vid.snippet.publishedAt);
        if (publishedAt < oneYearAgo) {
            continue; // Skip videos older than 1 year to optimize storage
        }

        const title = vid.snippet.title;
        const cleanDesc = cleanDescription(vid.snippet.description);
        
        // Generate Embedding!
        const semanticText = `Title: ${title}. Description: ${cleanDesc}`;
        let embedding = null;
        try {
            embedding = await getEmbedding(semanticText);
        } catch (e) {
            console.warn(`[Supabase] Failed to embed video ${vid.id}: `, e.message);
            continue;
        }

        videoRecords.push({
            id: vid.id,
            channel_id: channelId,
            title: title,
            clean_description: cleanDesc,
            thumbnail_url: vid.snippet.thumbnails?.medium?.url || '',
            published_at: vid.snippet.publishedAt,
            view_count: parseInt(vid.statistics?.viewCount || '0', 10),
            embedding: JSON.stringify(embedding) // pgvector format
        });
    }

    // Upsert to Supabase
    if (videoRecords.length > 0) {
        const { error } = await supabase.from('youtube_videos').upsert(videoRecords);
        if (error) console.error('[Supabase] Video Upsert Error:', error);
        else console.log(`[Supabase] Successfully ingested ${videoRecords.length} videos for channel ${channelId}`);
    }
}

/**
 * 3. Semantic Hybrid Search
 */
async function searchLocalVideos(queryText, limit = 5, userId = null) {
    if (!supabase) return [];
    try {
        const queryEmbedding = await getEmbedding(queryText);
        const targetUserId = userId && userId !== 'anonymous' ? userId : null;
        
        const { data, error } = await supabase.rpc('search_youtube_videos', {
            query_embedding: JSON.stringify(queryEmbedding),
            match_count: limit,
            similarity_threshold: 0.55,
            target_user_id: targetUserId
        });

        if (error) throw error;

        // --- Debug Logging for Semantic Similarity ---
        if (data && data.length > 0) {
            console.log(`\n[Supabase Search] Query: "${queryText}"${targetUserId ? ` user=${targetUserId}` : ''}`);
            data.forEach((v, i) => {
                const title = v.title.length > 50 ? v.title.slice(0, 50) + '...' : v.title;
                console.log(`   #${i+1} [Sim: ${v.similarity?.toFixed(4)}] [Sub: ${v.from_subscription ? 'yes' : 'no'}] [Views: ${v.view_count || 0}] -> ${title}`);
            });
        }
        // ---------------------------------------------

        return data;
    } catch (e) {
        console.error('[Supabase] Search Error:', e.message);
        return [];
    }
}

module.exports = {
    syncUserChannels,
    ingestChannel,
    searchLocalVideos,
    supabase,
    getEmbedding,
    cleanDescription
};
