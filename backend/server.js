require('dotenv').config();
const traceloop = require('@traceloop/node-server-sdk');

traceloop.initialize({
    appName: 'team-hackathon-backend',
    baseUrl: process.env.TRACELOOP_BASE_URL || 'http://127.0.0.1:6006',
    disableBatch: true // Send traces immediately for local debugging
});



const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const { GoogleGenAI } = require('@google/genai');
const Quest = require('./models/Quest');
const Document = require('./models/Document');
const UserSubscriptions = require('./models/UserSubscriptions');
const UserPreferences = require('./models/UserPreferences');
const { initRAG, storeSessionContext, storeDocumentChunks, retrieveRelevantContext, retrieveCategorizedContext, formatRAGContext, chunkText } = require('./ragService');
const { parseFile, SUPPORTED_MIMETYPES } = require('./fileParser');
const { syncUserChannels, searchLocalVideos } = require('./youtubeDiscoveryService');
const { startCron } = require('./youtubeSyncCron');

// Multer config — memory storage, 10MB max
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (SUPPORTED_MIMETYPES.includes(file.mimetype) || /\.(pdf|docx|txt)$/i.test(file.originalname)) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported file type. Only PDF, DOCX, and TXT are allowed.'));
        }
    },
});

const app = express();
const PORT = process.env.PORT || 5000;
const SUBSCRIPTION_CACHE_TTL_DAYS = 30;
const SUBSCRIPTION_CACHE_TTL_MS = SUBSCRIPTION_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

// Initialize Gemini API client
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(cors());
app.use(express.json());

// Connect to MongoDB
if (process.env.MONGODB_URI) {
    mongoose.connect(process.env.MONGODB_URI)
        .then(() => console.log('Connected to MongoDB Atlas'))
        .catch(err => console.error('MongoDB connection failure:', err.message));
} else {
    console.warn('MONGODB_URI not found in .env. Persistence disabled.');
}

// Initialize Pinecone RAG (non-blocking)
if (process.env.PINECONE_API_KEY) {
    initRAG().then(() => console.log('RAG system initialized.')).catch(err => console.warn('RAG init skipped:', err.message));
} else {
    console.warn('PINECONE_API_KEY not found. RAG disabled.');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const SYSTEM_PERSONA = `You are QuestMap AI — a professional learning coach with deep expertise in curriculum design, Bloom's taxonomy, and personalized education. 

CRITICAL RAG GROUNDING RULES:
1. If "REFERENCE MATERIAL" or "STRICT REFERENCE MATERIAL" is provided in the prompt, you MUST prioritize it over your internal knowledge. 
2. Use the terminology, specific names, and concepts found in the provided snippets. 
3. Avoid hallucinating concepts, frameworks, or advanced jargon that is NOT present in the provided context or intrinsic to the basic core topic.
4. If you aren't sure if a term is in the document, refer to it as "from your provided materials" or stick to simpler explanations.

You never hallucinate URLs. When suggesting YouTube videos, provide realistic search queries and broad watch-section guidance, not fabricated links or exact timestamps.`;

const YOUTUBE_DISPLAY_RESULT_COUNT = 8;
const YOUTUBE_SEARCH_CANDIDATE_COUNT = 50;
const YOUTUBE_SUBSCRIBED_CHANNEL_DISPLAY_CAP = 5;

function compactSearchText(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/[’']s\b/gi, '')
        .replace(/[’']/g, '')
        .replace(/[^a-zA-Z0-9\s]/g, ' ')
        .toLowerCase()
        .replace(/\b(what\s+is|what\s+are|the|a|an|overview|introduction|intro|basics|basic|core|of|to|tutorial)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function decodeHtmlText(value) {
    return String(value || '')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function hasMeaningfulOverlap(a, b) {
    const aWords = new Set(compactSearchText(a).split(' ').filter(Boolean));
    const bWords = compactSearchText(b).split(' ').filter(Boolean);
    if (aWords.size === 0 || bWords.length === 0) return false;

    const overlapCount = bWords.filter(word => aWords.has(word)).length;
    return overlapCount / bWords.length >= 0.6;
}

function buildYouTubeSearchQuery(topic, nodeLabel, keyConcepts = []) {
    const candidates = [
        compactSearchText(nodeLabel),
        compactSearchText(topic),
        ...(keyConcepts || []).map(compactSearchText),
    ].filter(Boolean);

    const queryParts = [];
    for (const candidate of candidates) {
        if (!queryParts.some(existing => hasMeaningfulOverlap(existing, candidate) || hasMeaningfulOverlap(candidate, existing))) {
            queryParts.push(candidate);
        }
    }

    const baseQuery = queryParts.slice(0, 2).join(' ') || compactSearchText(topic) || compactSearchText(nodeLabel);
    return `${baseQuery} explained`.trim();
}

function normalizeVideoSuggestion(video) {
    const { snippet_timestamp, ...rest } = video;
    return {
        ...rest,
        suggested_section: video.suggested_section || (snippet_timestamp ? 'Suggested watch focus' : undefined),
    };
}

function normalizeChannelName(channel) {
    return String(channel || '')
        .toLowerCase()
        .replace(/^the\s+/, '')
        .replace(/[^a-z0-9]/g, '');
}

function buildSubscribedChannelMatcher(subscribedChannels = []) {
    const idToOrder = new Map();
    const nameToOrder = new Map();

    subscribedChannels.forEach((channel, index) => {
        const order = index + 1;
        if (channel.id && !idToOrder.has(channel.id)) idToOrder.set(channel.id, order);

        const normalizedName = normalizeChannelName(channel.title || channel);
        if (normalizedName && !nameToOrder.has(normalizedName)) nameToOrder.set(normalizedName, order);
    });

    return (channelTitle, channelId = null) => {
        if (channelId && idToOrder.has(channelId)) return idToOrder.get(channelId);

        const normalizedName = normalizeChannelName(channelTitle);
        return nameToOrder.get(normalizedName) || null;
    };
}

function getChannelKey(item) {
    return item.snippet?.channelId || normalizeChannelName(item.snippet?.channelTitle);
}

function mapYouTubeSearchItem(item, searchQuery, index, fromSubscription = false, originalRank = index + 1) {
    const description = decodeHtmlText(item.snippet?.description);

    return {
        id: `search-${index + 1}`,
        display_rank: index + 1,
        original_rank: originalRank,
        youtube_rank: originalRank,
        video_id: item.id.videoId,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        title: decodeHtmlText(item.snippet?.title) || searchQuery,
        channel: decodeHtmlText(item.snippet?.channelTitle) || 'YouTube',
        channel_id: item.snippet?.channelId || null,
        search_query: searchQuery,
        description,
        why_relevant: fromSubscription
            ? `YouTube search result from one of your subscribed channels for "${searchQuery}"`
            : `YouTube search result for "${searchQuery}"`,
        suggested_section: null,
        snippet_description: description,
        skill_level: 'beginner | intermediate | advanced',
        from_subscription: fromSubscription,
        source_bucket: 'youtube_api_search',
        priority_bucket: fromSubscription ? 'subscribed_channel_match' : 'youtube_search_rank',
        match_confidence: fromSubscription ? 'youtube_api_subscribed_channel_match' : 'youtube_api_search_rank',
        thumbnail_url: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || null,
        published_at: item.snippet?.publishedAt || null,
    };
}

async function searchYouTubeApiVideos(searchQuery, subscribedChannels = [], displayCount = YOUTUBE_DISPLAY_RESULT_COUNT) {
    if (!process.env.YOUTUBE_API_KEY) {
        console.warn('YOUTUBE_API_KEY is missing. Cannot fetch YouTube API search results.');
        return [];
    }

    try {
        const url = new URL('https://www.googleapis.com/youtube/v3/search');
        url.searchParams.set('part', 'snippet');
        url.searchParams.set('maxResults', String(YOUTUBE_SEARCH_CANDIDATE_COUNT));
        url.searchParams.set('q', searchQuery);
        url.searchParams.set('type', 'video');
        url.searchParams.set('order', 'relevance');
        url.searchParams.set('safeSearch', 'moderate');
        url.searchParams.set('videoDuration', 'medium');
        url.searchParams.set('videoEmbeddable', 'true');
        url.searchParams.set('key', process.env.YOUTUBE_API_KEY);

        const res = await fetch(url.toString());
        if (!res.ok) {
            const errorText = await res.text();
            throw new Error(`YouTube API returned ${res.status}: ${errorText}`);
        }

        const data = await res.json();
        const items = (data.items || [])
            .filter(item => item.id?.videoId)
            .map((item, index) => ({
                item,
                originalRank: index + 1,
                fromSubscription: false,
            }));
        const isSubscribedChannel = buildSubscribedChannelMatcher(subscribedChannels);
        const subscribedMatchesByChannel = new Map();
        const regularMatches = [];

        for (const candidate of items) {
            candidate.subscriptionOrder = isSubscribedChannel(candidate.item.snippet?.channelTitle, candidate.item.snippet?.channelId);
            candidate.fromSubscription = candidate.subscriptionOrder !== null;
            if (candidate.fromSubscription) {
                const channelKey = getChannelKey(candidate.item);
                const existing = subscribedMatchesByChannel.get(channelKey);
                if (!existing || candidate.originalRank < existing.originalRank) {
                    subscribedMatchesByChannel.set(channelKey, candidate);
                }
            } else {
                regularMatches.push(candidate);
            }
        }

        const subscribedMatches = Array.from(subscribedMatchesByChannel.values());
        subscribedMatches.sort((a, b) => (
            a.originalRank - b.originalRank ||
            a.subscriptionOrder - b.subscriptionOrder
        ));

        const selectedSubscribedMatches = subscribedMatches.slice(0, YOUTUBE_SUBSCRIBED_CHANNEL_DISPLAY_CAP);

        return [...selectedSubscribedMatches, ...regularMatches]
            .slice(0, displayCount)
            .map((candidate, index) => mapYouTubeSearchItem(
                candidate.item,
                searchQuery,
                index,
                candidate.fromSubscription,
                candidate.originalRank
            ));
    } catch (err) {
        console.warn(`[YouTube API Search] Failed for "${searchQuery}":`, err.message);
        return [];
    }
}

async function searchSubscribedLocalVideos(searchQuery, userId, displayCount = 3) {
    if (!userId || userId === 'anonymous') return [];

    try {
        const results = await searchLocalVideos(searchQuery, displayCount, userId);
        return (results || [])
            .filter(video => video.from_subscription)
            .slice(0, displayCount)
            .map((video, index) => ({
                id: `local-subscription-${index + 1}`,
                video_id: video.id,
                url: `https://www.youtube.com/watch?v=${video.id}`,
                title: video.title,
                channel: video.channel_title || 'Subscribed Channel',
                channel_id: video.channel_id || null,
                search_query: searchQuery,
                why_relevant: `Matched from your subscribed channels for "${searchQuery}"`,
                suggested_section: 'core explanation',
                snippet_description: `Review the parts that explain ${searchQuery}.`,
                skill_level: 'beginner | intermediate | advanced',
                from_subscription: true,
                source_bucket: 'subscription_local_search',
                match_confidence: 'local_subscription_semantic_match',
                thumbnail_url: video.thumbnail_url || null,
                published_at: video.published_at || null,
            }));
    } catch (err) {
        console.warn(`[YouTube] Local subscription search failed for "${searchQuery}":`, err.message);
        return [];
    }
}

/**
 * Fetch all YouTube subscriptions for a user (paginated) and cache in MongoDB.
 * On cache hit, returns immediately without calling the YouTube API.
 * On cache miss, paginates through ALL subscription pages (50/page) when a token is available.
 */
async function fetchAndCacheSubscriptions(userId, ytAccessToken) {
    // 1. Check MongoDB cache first
    try {
        const cached = await UserSubscriptions.findOne({ userId });
        if (cached && cached.channels.length > 0) {
            console.log(`[YouTube] Using cached ${cached.totalCount} subscriptions for userId: ${userId}`);
            return cached.channels;
        }
    } catch (dbErr) {
        console.warn('[YouTube] Cache lookup failed:', dbErr.message);
    }

    if (!ytAccessToken) {
        console.log(`[YouTube] No cached subscriptions and no OAuth token for userId: ${userId}. Skipping subscription prioritization.`);
        return [];
    }

    // 2. Paginate through all YouTube subscriptions
    const allChannels = [];
    let nextPageToken = null;
    let pageCount = 0;

    console.log(`[YouTube] Fetching all subscriptions for userId: ${userId}...`);
    try {
        do {
            const url = new URL('https://www.googleapis.com/youtube/v3/subscriptions');
            url.searchParams.set('part', 'snippet');
            url.searchParams.set('mine', 'true');
            url.searchParams.set('maxResults', '50');
            url.searchParams.set('order', 'alphabetical');
            if (nextPageToken) url.searchParams.set('pageToken', nextPageToken);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const res = await fetch(url.toString(), {
                signal: controller.signal,
                headers: { Authorization: `Bearer ${ytAccessToken}` },
            });
            clearTimeout(timeout);

            if (!res.ok) {
                const errBody = await res.json().catch(() => ({}));
                console.warn(`[YouTube] Subscriptions API error (page ${pageCount + 1}):`, res.status, errBody?.error?.message);
                break;
            }

            const data = await res.json();
            pageCount++;

            for (const item of (data.items || [])) {
                allChannels.push({
                    id: item.snippet.resourceId.channelId,
                    title: item.snippet.title || '',
                    description: item.snippet.description || '',
                });
            }

            nextPageToken = data.nextPageToken || null;
            console.log(`[YouTube] Page ${pageCount}: fetched ${data.items?.length || 0} channels (total so far: ${allChannels.length})`);
        } while (nextPageToken);
    } catch (fetchErr) {
        console.warn('[YouTube] Subscription fetch failed mid-pagination:', fetchErr.message);
    }

    console.log(`[YouTube] Fetched ${allChannels.length} total subscriptions across ${pageCount} pages.`);

    // 3. Store in MongoDB (upsert — replaces any existing stale doc)
    if (allChannels.length > 0) {
        try {
            await UserSubscriptions.findOneAndUpdate(
                { userId },
                { channels: allChannels, totalCount: allChannels.length, fetchedAt: new Date() },
                { upsert: true, new: true }
            );
            console.log(`[YouTube] Cached ${allChannels.length} subscriptions for userId: ${userId} (${SUBSCRIPTION_CACHE_TTL_DAYS}-day TTL).`);
        } catch (saveErr) {
            console.warn('[YouTube] Failed to cache subscriptions:', saveErr.message);
        }
    }

    return allChannels;
}

/**
 * Attempt to repair malformed JSON from LLM output.
 * Handles: unterminated strings, missing closing brackets/braces, trailing commas.
 */
function repairJSON(text) {
    // Remove markdown fences
    text = text.replace(/```json|```/g, '').trim();

    // Try parsing as-is first
    try { return JSON.parse(text); } catch {}

    // Fix trailing commas before } or ]
    let fixed = text.replace(/,\s*([\]}])/g, '$1');

    // Try again
    try { return JSON.parse(fixed); } catch {}

    // Count open/close brackets and braces to find what's missing
    let openBraces = 0, openBrackets = 0, inString = false, escaped = false;
    for (let i = 0; i < fixed.length; i++) {
        const ch = fixed[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') openBraces++;
        if (ch === '}') openBraces--;
        if (ch === '[') openBrackets++;
        if (ch === ']') openBrackets--;
    }

    // If we ended inside a string, close it
    if (inString) fixed += '"';

    // Remove any trailing comma
    fixed = fixed.replace(/,\s*$/, '');

    // Close any open brackets/braces
    while (openBrackets > 0) { fixed += ']'; openBrackets--; }
    while (openBraces > 0) { fixed += '}'; openBraces--; }

    try { return JSON.parse(fixed); } catch {}

    // Last resort: truncate to last valid closing brace/bracket and try
    const lastBrace = fixed.lastIndexOf('}');
    const lastBracket = fixed.lastIndexOf(']');
    const cutPoint = Math.max(lastBrace, lastBracket);
    if (cutPoint > 0) {
        const truncated = fixed.substring(0, cutPoint + 1);
        try { return JSON.parse(truncated); } catch {}
    }

    throw new Error('Unable to parse or repair JSON from model output');
}

/**
 * Scrape authentic title and image from redirect URLs.
 */
async function fetchLinkPreview(redirectUrl) {
    try {
        const response = await fetch(redirectUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(4000) // 4 second timeout
        });
        
        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);
        
        const html = await response.text();
        
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : null;
        
        const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
        const image = ogImageMatch ? ogImageMatch[1].trim() : null;
        
        return { title, image, url: response.url, failed: false };
    } catch (err) {
        return { title: null, image: null, url: null, failed: true };
    }
}

/**
 * Call Gemini API with a prompt and return parsed JSON.
 * Uses @google/genai SDK for tracing compatibility.
 */
async function callGemini(prompt, retries = 2, useSearch = false) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const config = {
                temperature: 0.4,
                maxOutputTokens: 8192,
                systemInstruction: 'You MUST respond with valid, complete JSON only. No markdown, no commentary. Ensure all strings are properly terminated and all brackets/braces are closed.',
            };
            if (useSearch) {
                config.tools = [{ googleSearch: {} }];
            } else {
                config.responseMimeType = 'application/json';
            }

            const response = await ai.models.generateContent({
                model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash-lite',
                contents: prompt,
                config,
            });

            let text = response.text || '';
            if (useSearch) {
                const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/);
                if (jsonMatch) text = jsonMatch[1];
            }
            
            return repairJSON(text);
        } catch (err) {
            if (attempt === retries) throw err;
            console.warn(`Gemini API attempt ${attempt + 1} failed, retrying...`, err.message);
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // backoff
        }
    }
}

/**
 * Call Gemini Search to strictly extract vertexaisearch grounding URLs.
 * Uses the generic prompt approach to guarantee exact search entry points.
 */
async function searchArticles(topic, node_label, userId) {
    try {
        let prefsString = "";
        if (userId) {
            const prefs = await UserPreferences.findOne({ userId });
            if (prefs) {
                if (prefs.preferredDomains?.length > 0) {
                    prefsString += ` Prioritize results from: ${prefs.preferredDomains.join(', ')}.`;
                }
                if (prefs.deprioritizedDomains?.length > 0) {
                    prefsString += ` Exclude results from: ${prefs.deprioritizedDomains.join(', ')}.`;
                }
            }
        }

        const query = `${topic} ${node_label}`;
        const response = await ai.models.generateContent({
            model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash-lite',
            contents: `Perform Google search for '${query}'${prefsString}`,
            config: {
                temperature: 0.2,
                tools: [{ googleSearch: {} }]
            }
        });

        const meta = response.candidates?.[0]?.groundingMetadata;
        const chunks = meta?.groundingChunks || [];
        
        const articles = [];
        let idCounter = 1;
        
        // Execute fetchLinkPreview in parallel for all URLs
        const previewPromises = chunks.map(async (chunk) => {
            if (chunk.web && chunk.web.uri) {
                const preview = await fetchLinkPreview(chunk.web.uri);
                if (!preview.failed && preview.url) {
                    return {
                        id: 0, // Assigned later
                        source: preview.title ? (chunk.web.title || preview.title.split('-')[0].trim()) : (chunk.web.title || 'Web Resource'),
                        title: preview.title || 'Article',
                        url: preview.url,
                        image: preview.image || null,
                        why_relevant: `Found via Google Search for ${query}`,
                        estimated_read_time: "5 min"
                    };
                }
            }
            return null;
        });

        const results = await Promise.all(previewPromises);
        
        for (const res of results) {
            if (res) {
                res.id = idCounter++;
                articles.push(res);
            }
        }
        
        return articles;
    } catch (err) {
        console.warn('[SearchArticles] Failed to fetch articles:', err.message);
        return [];
    }
}

// ─── COMMENTED OUT: Gemma/Ollama local LLM (kept for reference) ─────────────
// /**
//  * Call local Gemma 4 12B model served by Ollama with a prompt and return parsed JSON.
//  * Uses OpenAI SDK so Traceloop auto-instruments LLM inputs, outputs, latency, and tokens.
//  */
// async function callGemini(prompt, retries = 2) {
//     const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').trim();
//     const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:12b';
//
//     const openai = new OpenAI({
//         baseURL: `${OLLAMA_BASE_URL}/v1`,
//         apiKey: 'ollama', // Required by SDK but ignored by Ollama
//         defaultHeaders: {
//             'Origin': 'http://localhost:11434',
//             'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
//             'ngrok-skip-browser-warning': 'true'
//         }
//     });
//
//     for (let attempt = 0; attempt <= retries; attempt++) {
//         try {
//             const completion = await openai.chat.completions.create({
//                 model: OLLAMA_MODEL,
//                 messages: [
//                     { role: 'system', content: 'You MUST respond with valid, complete JSON only. No markdown, no commentary. Ensure all strings are properly terminated and all brackets/braces are closed.' },
//                     { role: 'user', content: prompt }
//                 ],
//                 response_format: { type: 'json_object' },
//                 temperature: 0.4,
//                 max_tokens: 8192
//             }, { timeout: 120000 }); // 2 min timeout
//
//             const text = completion.choices?.[0]?.message?.content || '';
//             return repairJSON(text);
//         } catch (err) {
//             if (attempt === retries) throw err;
//             console.warn(`Ollama attempt ${attempt + 1} failed, retrying...`, err.message);
//         }
//     }
// }

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
    res.json({ status: 'QuestMap Backend is Running', timestamp: new Date() });
});

// ─── 1. Generate Profile & Synthetic Learning History ───────────────────────

app.post('/api/generate-profile', async (req, res) => {
    const { topic, skill_level, background, goals } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    const prompt = `${SYSTEM_PERSONA}

The learner wants to study: "${topic}"
Skill level: "${skill_level || 'beginner'}"
Professional background: "${background || 'Not specified'}"
Learning goals: "${goals || 'General mastery of the topic'}"

Your task: Generate a realistic synthetic learning history for this learner that would come from a learning app. Think step-by-step:
1. Based on their skill level, determine what they would have ALREADY learned
2. Based on their background, infer what adjacent skills they possess
3. Generate realistic data including completion percentages, quiz scores, and time invested

Return valid JSON matching this exact schema:
{
    "learner_summary": "A 2-3 sentence summary of the learner's profile and where they stand",
    "inferred_skills": ["skill1", "skill2"],
    "learning_history": [
        {
            "topic": "Topic they previously studied",
            "status": "completed | in_progress | abandoned",
            "completion_percent": 85,
            "quiz_score": 78,
            "hours_spent": 12,
            "date_completed": "2025-11-15"
        }
    ],
    "strengths": ["strength1", "strength2"],
    "knowledge_gaps": ["gap1", "gap2"],
    "recommended_pace": "aggressive | moderate | gentle",
    "estimated_total_hours": 40
}

Generate 5-8 learning history entries that would realistically precede studying "${topic}" at a "${skill_level || 'beginner'}" level. Make the data coherent with their background.`;

    try {
        console.log(`[${new Date().toISOString()}] Profile generation for: "${topic}"`);
        const json = await callGemini(prompt);
        console.log(`[${new Date().toISOString()}] Profile generated successfully.`);
        res.json(json);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Profile Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate profile', details: error.message });
    }
});

// ─── 2. Generate Knowledge Map (Enhanced) ───────────────────────────────────

app.post('/api/generate-map', async (req, res) => {
    const { topic, skill_level, background, goals, learning_history, userId } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    const historyContext = learning_history
        ? `\nThe learner's past learning history:\n${JSON.stringify(learning_history, null, 2)}`
        : '';

    const prompt = `${SYSTEM_PERSONA}

The learner wants to master: "${topic}"
Skill level: "${skill_level || 'beginner'}"
Background: "${background || 'Not specified'}"
Goals: "${goals || 'General mastery'}"
${historyContext}

Create a comprehensive, personalized knowledge map for learning "${topic}". Think step-by-step:
1. Identify the 8-10 core sub-topics needed to master this subject
2. Determine the logical learning order (prerequisites first)
3. Assign a Bloom's taxonomy level to each node
4. Based on the learner's history, mark which topics they may have partially covered
5. Estimate realistic time investment for each topic

Return valid JSON matching this exact schema:
{
    "map_title": "Learning Path: ${topic}",
    "total_estimated_hours": 60,
    "nodes": [
        {
            "id": "1",
            "label": "Topic Name",
            "description": "What this covers and why it matters",
            "bloom_level": "Remember | Understand | Apply | Analyze | Evaluate | Create",
            "difficulty": "beginner | intermediate | advanced",
            "estimated_hours": 5,
            "status": "completed | in_progress | not_started | recommended_next",
            "key_concepts": ["concept1", "concept2", "concept3"],
            "prerequisites": []
        }
    ],
    "edges": [
        {
            "source": "1",
            "target": "2",
            "relationship": "prerequisite | recommended | optional"
        }
    ]
}

Mark 1-2 nodes as "recommended_next" — these are what the learner should focus on NOW. Nodes they likely already know (based on history) should be "completed". Ensure the graph is a connected DAG.`;

    try {
        console.log(`[${new Date().toISOString()}] Map generation for: "${topic}"`);

        // RAG: Retrieve categorized document context
        let sourceContextStr = '';
        let personalContextStr = '';

        let sourceMaterials = [];
        let contextMaterials = [];

        if (userId && process.env.PINECONE_API_KEY) {
            try {
                const results = await retrieveCategorizedContext(userId, topic, 15);
                sourceMaterials = results.sourceMaterials;
                contextMaterials = results.contextMaterials;

                if (sourceMaterials.length > 0) {
                    sourceContextStr = '\n\n### Source Material Context (CRITICAL: Use this to define the strict curriculum structure and chapters)\n';
                    sourceMaterials.forEach(m => sourceContextStr += `[From "${m.filename}"]: ${m.content}\n`);
                }
                if (contextMaterials.length > 0) {
                    personalContextStr = '\n\n### Personal Context (CRITICAL: Use this to identify the user\'s weak points, prior knowledge, and exam mistakes)\n';
                    contextMaterials.forEach(m => personalContextStr += `[From "${m.filename}"]: ${m.content}\n`);
                }
                console.log(`[${new Date().toISOString()}] Map RAG injected (${sourceMaterials.length} source chunks, ${contextMaterials.length} context chunks).`);
            } catch (ragErr) {
                console.warn('Map generation RAG retrieval skipped:', ragErr.message);
            }
        }

        const ragInstructions = (sourceContextStr || personalContextStr) ? `
        
### CRITICAL DOMAIN RELEVANCE GUARD
The following document snippets were retrieved for the topic: "${topic}". 
- **STRICT MISMATCH CHECK**: If the user is asking for a broad topic (like "Machine Learning") but the documents are about a very specific and narrow application (like "Video Summarization research"), you **MUST IGNORE** the documents. Do not let narrow research papers skew a broad foundational curriculum.
- **AUTHORITY**: You have the absolute authority to discard all provided snippets if they do not directly align with "${topic}".
- If they ARE a direct match:
${sourceMaterials.length > 0 ? '  - Align the core nodes with the Source Material structure.' : ''}
${personalContextStr ? '  - Use Personal Context to identify gaps (e.g. from mistakes).' : ''}
` : '';

        const fullPrompt = prompt + sourceContextStr + personalContextStr + ragInstructions;

        const json = await callGemini(fullPrompt);
        console.log(`[${new Date().toISOString()}] Map generated with ${json.nodes?.length} nodes.`);

        // Attach retrieval context for transparency
        res.json({
            ...json,
            _debug_context: {
                source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
                personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content }))
            }
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Map Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate map', details: error.message });
    }
});

// ─── 3. Generate Personalized Recommendations ──────────────────────────────

app.post('/api/generate-recommendations', async (req, res) => {
    const { topic, skill_level, background, goals, learning_history, knowledge_gaps } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    const prompt = `${SYSTEM_PERSONA}

The learner is studying: "${topic}"
Skill level: "${skill_level || 'beginner'}"
Background: "${background || 'Not specified'}"
Goals: "${goals || 'General mastery'}"
Known knowledge gaps: ${JSON.stringify(knowledge_gaps || [])}
Learning history summary: ${JSON.stringify(learning_history || [])}

### CRITICAL DOMAIN RELEVANCE GUARD
The following snippets were retrieved for the topic: "${topic}". 
- **STRICT MISMATCH CHECK**: If the user is asking for a broad topic (like "Machine Learning") but the documents are about a very specific and narrow application (like "Video Summarization research"), you **MUST IGNORE** the documents. Do not let narrow research papers skew a broad foundational curriculum.
- **AUTHORITY**: You have the absolute authority to discard all provided snippets if they do not directly align with "${topic}".
- If they ARE relevant, follow these prioritize rules:
1. Generate 6 personalized next-step learning recommendations.
2. If "Source Material" chunks are relevant, ensure at least 3 recommendations are directly derived from that material.
3. If "Personal Context" chunks are relevant and indicate specific mistakes/weaknesses, prioritize those as "High".
4. For EACH recommendation:
   - Provide the recommendation and REASON about why it matches their profile.
   - Only tie the reason to documents (e.g., "From your uploaded textbook...") if the documents are actually relevant.

Return valid JSON matching this exact schema:
{
    "recommendations": [
        {
            "id": 1,
            "priority": "high | medium | low",
            "title": "What to learn next",
            "description": "Detailed description",
            "reason": "Specific, personalized reason grounding it in their history or uploaded docs",
            "estimated_hours": 4,
            "difficulty": "beginner | intermediate | advanced",
            "prerequisites_met": true,
        }
    ]
}

Generate exactly 6 recommendations ordered by priority. At least 2 must be "high" priority.`;

    try {
        console.log(`[${new Date().toISOString()}] Recommendations for: "${topic}"`);

        // RAG: Retrieve relevant past context
        let ragContext = '';
        let ragResults = null;
        const userId = req.body.userId || 'anonymous';
        if (process.env.PINECONE_API_KEY) {
            try {
                ragResults = await retrieveRelevantContext(userId, `${topic} ${skill_level || ''}`);
                ragContext = formatRAGContext(ragResults);
                if (ragContext) console.log(`[${new Date().toISOString()}] RAG context injected (${ragResults.sessions.length} sessions, ${ragResults.documents.length} doc chunks).`);
            } catch (ragErr) {
                console.warn('RAG retrieval skipped:', ragErr.message);
            }
        }

        // Rebuild prompt with RAG context
        const fullPrompt = ragContext ? prompt + '\n' + ragContext : prompt;
        const json = await callGemini(fullPrompt);
        console.log(`[${new Date().toISOString()}] Generated ${json.recommendations?.length} recommendations.`);

        // Auto-store session context in Pinecone (non-blocking)
        if (process.env.PINECONE_API_KEY) {
            storeSessionContext(userId, { topic, skill_level, type: 'recommendations', node_label: 'overview', summary: `Generated ${json.recommendations?.length} recommendations for ${topic}` }).catch(() => { });
        }

        // Include debug context in response for frontend transparency
        const _debug_context = {
            source: (ragResults?.documents || []).filter(d => d.category === 'source').map(m => ({ filename: m.filename, content: m.content })),
            personal: (ragResults?.documents || []).filter(d => d.category === 'context').map(m => ({ filename: m.filename, content: m.content })),
            sessions: (ragResults?.sessions || []).map(s => ({ topic: s.topic, summary: s.summary }))
        };

        res.json({ ...json, _debug_context });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Recommendations Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate recommendations', details: error.message });
    }
});

// ─── 4+5. MERGED: Generate Node Data (Practice + Resources in one call) ─────

app.post('/api/generate-node-data', async (req, res) => {
    const { topic, node_label, skill_level, key_concepts, userId, ytAccessToken } = req.body;

    if (!topic || !node_label) {
        return res.status(400).json({ error: 'Topic and node_label are required' });
    }

    // ── SINGLE Pinecone RAG lookup (shared by both practice & resources) ─────
    let referenceContext = '';
    let sourceMaterials = [];
    let contextMaterials = [];
    if (userId && process.env.PINECONE_API_KEY) {
        try {
            const results = await retrieveCategorizedContext(userId, `${topic} ${node_label}`, 5);
            sourceMaterials = results.sourceMaterials;
            contextMaterials = results.contextMaterials;

            if (sourceMaterials.length > 0 || contextMaterials.length > 0) {
                referenceContext = '\n\n### STRICT REFERENCE MATERIAL (Only use these concepts/terms):\n';
                [...sourceMaterials, ...contextMaterials].forEach(m => {
                    referenceContext += `- [${m.filename}]: ${m.content}\n`;
                });
            }
        } catch (e) {
            console.warn("RAG retrieval for node data failed:", e.message);
        }
    }

    // ── Build PRACTICE prompt ────────────────────────────────────────────────
    const practicePrompt = `${SYSTEM_PERSONA}
${referenceContext}

The learner is studying "${topic}" and is currently on the sub-topic: "${node_label}"
Skill level: "${skill_level || 'beginner'}"
Key concepts to test: ${JSON.stringify(key_concepts || [])}

Generate practice scenarios to test and reinforce their understanding. 

### CRITICAL DOMAIN RELEVANCE GUARD
The following snippets were retrieved for the topic: "${topic}" and sub-topic: "${node_label}". 
- **STRICT MISMATCH CHECK**: If the snippets are about a very specific application (like "Video Summarization") while the user is learning a broad topic (like "Machine Learning"), you **MUST IGNORE** them.
- **AUTHORITY**: Only use this material if it is a DIRECT and NECESSARY match for "${node_label}". Otherwise, use standard educational best practices for "${node_label}".
- If they ARE relevant, follow these CRITICAL rules:
  - You MUST only test concepts and use terminology found in the ABOVE REFERENCE MATERIAL or directly intrinsic to "${node_label}". 
  - Do NOT introduce outside framework names or advanced jargon that is NOT in the reference material.
  - Design questions that test understanding of THIS material, not general trivia.

Think step-by-step:
1. What are the most important concepts mentioned in the provided document chunks?
2. What terms are specific to this user's source material?
3. Design questions that test understanding of THIS material, not general trivia.

Return valid JSON matching this exact schema:
{
    "practice_title": "Practice: ${node_label}",
    "scenarios": [
        {
            "id": 1,
            "type": "multiple_choice",
            "difficulty": "beginner | intermediate | advanced",
            "question": "Clear, specific question text",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correct_answer": 0,
            "explanation": "Detailed explanation of why this is correct and why other options are wrong"
        },
        {
            "id": 2,
            "type": "scenario",
            "difficulty": "intermediate",
            "question": "A real-world scenario the learner must analyze",
            "context": "Background context for the scenario",
            "solution": "Step-by-step solution with reasoning",
            "key_takeaway": "What the learner should remember from this"
        },
        {
            "id": 3,
            "type": "code_challenge",
            "difficulty": "intermediate",
            "question": "A coding task description",
            "starter_code": "// Starting code or pseudocode",
            "solution_code": "// Complete solution",
            "explanation": "Why this solution works"
        }
    ]
}

Generate exactly 5 scenarios: 2 multiple_choice, 2 scenario, 1 code_challenge. Ensure they progress in difficulty.`;

    // ── Build RESOURCES prompt ───────────────────────────────────────────────
    const resourceRefContext = (sourceMaterials.length > 0 || contextMaterials.length > 0)
        ? '\n\n### REFERENCE MATERIAL FROM UPLOADED DOCUMENTS (Use this to find relevant external resources):\n' +
          [...sourceMaterials, ...contextMaterials].map(m => `- [${m.filename}]: ${m.content}`).join('\n')
        : '';

    const resourcePrompt = `${SYSTEM_PERSONA}
${resourceRefContext}

The learner is studying "${topic}", specifically the sub-topic: "${node_label}"
Skill level: "${skill_level || 'beginner'}"

### CRITICAL DOMAIN RELEVANCE GUARD
The following snippets were retrieved for the topic: "${topic}" and sub-topic: "${node_label}". 
- **STRICT MISMATCH CHECK**: If the snippets are about a very specific application (like "Video Summarization") while the user is learning a broad topic (like "Machine Learning"), you **MUST IGNORE** them.
- **AUTHORITY**: Only use this material if it is a DIRECT and NECESSARY match for "${node_label}". Otherwise, provide standard high-quality resources for "${topic}".
- If they ARE relevant:
  - Curate highly specific resources that complement the user's provided material.

Think step-by-step:
1. What official documentation, tutorials, or books are most relevant?
2. Which books would support this sub-topic at the learner's skill level?
3. Do NOT generate YouTube videos. The backend retrieves YouTube videos separately from real search APIs.

Return valid JSON matching this exact schema:
{
    "resources_for": "${node_label}",
    "books": [
        {
            "title": "Book title",
            "author": "Author name",
            "relevant_chapter": "Chapter or section most relevant",
            "why_relevant": "Why this book helps"
        }
    ]
}

Provide 2 books. Do not include YouTube video fields.`;

    // ── YouTube Subscription Context (for resources only) ────────────────────
    let subscribedChannels = [];

    if (userId && userId !== 'anonymous' && process.env.MONGODB_URI) {
        try {
            const allChannels = await fetchAndCacheSubscriptions(userId, ytAccessToken);
            subscribedChannels = allChannels.map(ch => ({ id: ch.id, title: ch.title }));
        } catch (subErr) {
            console.warn('[YouTube] Subscription enrichment failed (non-fatal):', subErr.message);
        }
    }

    // ── Fire LLM and deterministic YouTube lookups in parallel ────────────────
    try {
        const videoSearchQuery = buildYouTubeSearchQuery(topic, node_label, key_concepts);
        console.log(`[${new Date().toISOString()}] Node data for: "${node_label}" (1 RAG lookup, parallel practice/resources/search)`);

        const [practiceJson, resourceJson, articlesList, subscriptionVideos, searchVideos] = await Promise.all([
            callGemini(practicePrompt),
            callGemini(resourcePrompt), // JSON format, no YouTube videos
            searchArticles(topic, node_label, userId), // Text format, YES Search Grounding
            searchSubscribedLocalVideos(videoSearchQuery, userId, 3),
            searchYouTubeApiVideos(videoSearchQuery, subscribedChannels, 8)
        ]);

        console.log(`[${new Date().toISOString()}] Generated ${practiceJson.scenarios?.length} practice scenarios.`);
        console.log(`[${new Date().toISOString()}] Selected YouTube videos: ${subscriptionVideos.length} local subscription, ${searchVideos.filter(v => v.from_subscription).length} subscribed-channel API matches, ${searchVideos.length} API total.`);
        console.log(`[${new Date().toISOString()}] Found ${articlesList?.length} articles via Grounding.`);

        const actualArticles = [];

        for (const article of (articlesList || [])) {
            if (!article.url || (!article.url.includes('youtube.com') && !article.url.includes('youtu.be'))) {
                actualArticles.push(article);
            }
        }

        // Inject the cleanly filtered articles into the JSON
        resourceJson.articles = actualArticles;

        resourceJson.subscription_videos = subscriptionVideos
            .map((video, i) => ({ ...normalizeVideoSuggestion(video), id: `subscription-${i + 1}` }));
        resourceJson.youtube_videos = searchVideos
            .map((video, i) => ({ ...normalizeVideoSuggestion(video), id: `search-${i + 1}` }));
        resourceJson.all_youtube_videos = [...resourceJson.subscription_videos, ...resourceJson.youtube_videos]
            .map((video, i) => ({ ...video, display_order: i + 1 }));
        delete resourceJson.subscribed_videos;

        const verifiedSubscriptionCount = resourceJson.all_youtube_videos.filter(v => v.from_subscription).length;
        console.log(`[YouTube] Displaying ${subscriptionVideos.length} local subscription videos plus ${searchVideos.length} API search videos (${verifiedSubscriptionCount} subscription-related total).`);

        // Debug context
        const _debug_context = {
            source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
            personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content })),
            subscribed_channels: subscribedChannels.map(ch => ch.title),
        };

        res.json({
            practice: { ...practiceJson, _debug_context },
            resources: { ...resourceJson, _debug_context }
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Node Data Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate node data', details: error.message });
    }
});




app.post('/api/generate-quiz', async (req, res) => {
    const { topic, skill_level, node_label } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    const focusScope = node_label ? `specifically focusing on the sub-topic: "${node_label}"` : `covering the general domain`;

    const prompt = `${SYSTEM_PERSONA}

The learner is studying "${topic}", ${focusScope}.
Current Skill Level: "${skill_level || 'beginner'}".

Generate a Candy-Crush style progressive "Level Quiz" with exactly 5 levels. Each level must be slightly harder than the previous one. The goal is to test their mastery step-by-step.

Return valid JSON matching this exact schema WITHOUT Markdown formatting:
{
    "quiz_title": "Mastery Check: ${topic}",
    "levels": [
        {
            "level_number": 1,
            "title": "Level 1: The Basics (Catchy Title)",
            "description": "A short, fun description of what this level tests.",
            "question": "A clear multiple-choice question testing fundamental concepts.",
            "options": ["Option A", "Option B", "Option C", "Option D"],
            "correct_index": 0,
            "success_message": "Awesome! You've grasped the fundamentals.",
            "failure_message": "Not quite! Remember that [brief explanation]."
        }
    ]
}

Ensure there are exactly 5 objects in the "levels" array, progressing from fundamental to advanced application. Provide EXACTLY 4 options for each question. "correct_index" must be an integer from 0 to 3.`;

    try {
        console.log(`[${new Date().toISOString()}] Generating Level Quiz for: "${topic}" ${node_label ? `(${node_label})` : ''}`);
        const json = await callGemini(prompt);
        console.log(`[${new Date().toISOString()}] Generated ${json.levels?.length || 0} quiz levels.`);
        res.json(json);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Quiz Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate quiz', details: error.message });
    }
});

// ─── 6. Save & Fetch Quests (History) ───────────────────────────────────────

app.post('/api/save-quest', async (req, res) => {
    try {
        const { userId, topic, skillLevel, profileData, mapData, recommendations } = req.body;
        if (!userId || !topic) return res.status(400).json({ error: 'UserId and Topic are required' });

        const quest = new Quest({
            userId,
            topic,
            skillLevel,
            profileData,
            mapData,
            recommendations
        });

        await quest.save();
        res.json({ message: 'Quest saved successfully', id: quest._id });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save quest', details: err.message });
    }
});

app.get('/api/user-quests/:uid', async (req, res) => {
    try {
        const quests = await Quest.find({ userId: req.params.uid }).sort({ timestamp: -1 });
        res.json(quests);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch history', details: err.message });
    }
});

app.delete('/api/quest/:id', async (req, res) => {
    try {
        await Quest.findByIdAndDelete(req.params.id);
        res.json({ message: 'Quest deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete entry', details: err.message });
    }
});

// ── Domain Preferences Endpoints ──────────────────────────────────────────

app.get('/api/user-preferences/:userId', async (req, res) => {
    try {
        const prefs = await UserPreferences.findOne({ userId: req.params.userId });
        if (!prefs) {
            return res.json({ preferredDomains: [], deprioritizedDomains: [] });
        }
        res.json(prefs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user-preferences', async (req, res) => {
    try {
        const { userId, preferredDomains, deprioritizedDomains } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId is required' });

        const prefs = await UserPreferences.findOneAndUpdate(
            { userId },
            { 
                userId, 
                preferredDomains: preferredDomains || [], 
                deprioritizedDomains: deprioritizedDomains || [],
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );
        res.json(prefs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── RAG / Pinecone Document Management ────────────────────────────────────

app.post('/api/upload-document', upload.single('file'), async (req, res) => {
    const { userId, category = 'source' } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!userId) return res.status(400).json({ error: 'userId is required' });

    let doc = null;
    try {
        // Save document metadata to MongoDB
        if (process.env.MONGODB_URI) {
            doc = new Document({
                userId,
                category,
                filename: req.file.originalname,
                mimetype: req.file.mimetype,
                fileSize: req.file.size,
                status: 'processing',
            });
            await doc.save();
        }

        // Parse file
        console.log(`[${new Date().toISOString()}] Parsing file: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);
        const text = await parseFile(req.file.buffer, req.file.mimetype, req.file.originalname);
        console.log(`[${new Date().toISOString()}] Extracted ${text.length} characters.`);

        // Chunk text
        const chunks = chunkText(text, 500, 100);
        console.log(`[${new Date().toISOString()}] Split into ${chunks.length} chunks.`);

        // Store in Pinecone
        let storedCount = 0;
        if (process.env.PINECONE_API_KEY && chunks.length > 0) {
            const docId = doc ? doc._id.toString() : `temp_${Date.now()}`;
            storedCount = await storeDocumentChunks(userId, docId, chunks, req.file.originalname, category);
        }

        // Update document status
        if (doc) {
            doc.chunkCount = storedCount;
            doc.textLength = text.length;
            doc.status = 'ready';
            await doc.save();
        }

        res.json({
            message: 'Document uploaded and processed successfully',
            document: {
                id: doc?._id,
                filename: req.file.originalname,
                textLength: text.length,
                chunkCount: chunks.length,
                storedVectors: storedCount,
                status: 'ready',
            },
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Upload Error:`, err.message);
        if (doc) {
            doc.status = 'failed';
            await doc.save().catch(() => { });
        }
        res.status(500).json({ error: 'Failed to process document', details: err.message });
    }
});

app.get('/api/user-documents/:uid', async (req, res) => {
    try {
        if (!process.env.MONGODB_URI) return res.json([]);
        const docs = await Document.find({ userId: req.params.uid }).sort({ uploadedAt: -1 });
        res.json(docs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch documents', details: err.message });
    }
});

app.delete('/api/document/:id', async (req, res) => {
    try {
        await Document.findByIdAndDelete(req.params.id);
        res.json({ message: 'Document deleted' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete document', details: err.message });
    }
});

// ─── Debug: YouTube Subscription Inspection ─────────────────────────────────

// GET /api/debug-subscriptions/:userId
// Returns what is currently cached in MongoDB for this user.
app.get('/api/debug-subscriptions/:userId', async (req, res) => {
    try {
        const doc = await UserSubscriptions.findOne({ userId: req.params.userId });
        if (!doc) {
            return res.json({ cached: false, message: 'No subscription cache found for this userId.' });
        }
        res.json({
            cached: true,
            userId: doc.userId,
            totalCount: doc.totalCount,
            fetchedAt: doc.fetchedAt,
            expiresAt: new Date(new Date(doc.fetchedAt).getTime() + SUBSCRIPTION_CACHE_TTL_MS),
            sample: doc.channels.slice(0, 10), // first 10 channels as a preview
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/debug-yt-token
// Body: { ytAccessToken }  — tests if the token works against YouTube API.
app.post('/api/debug-yt-token', async (req, res) => {
    const { ytAccessToken } = req.body;
    if (!ytAccessToken) return res.status(400).json({ error: 'ytAccessToken required' });

    try {
        const ytRes = await fetch(
            'https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=3',
            { headers: { Authorization: `Bearer ${ytAccessToken}` } }
        );
        const data = await ytRes.json();
        if (!ytRes.ok) {
            return res.status(ytRes.status).json({ youtubeError: data?.error });
        }
        res.json({
            ok: true,
            totalResults: data.pageInfo?.totalResults,
            sample: (data.items || []).map(i => ({
                channel: i.snippet.title,
                description: i.snippet.description?.slice(0, 80),
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Supabase YouTube Discovery APIs ────────────────────────────────────────

// POST /api/youtube/sync-subscriptions
// Fetches the user's YouTube subscriptions and adds channels to the Supabase DB
app.post('/api/youtube/sync-subscriptions', async (req, res) => {
    const { ytAccessToken, userId } = req.body;
    if (!ytAccessToken || !userId) return res.status(400).json({ error: 'ytAccessToken and userId required' });

    try {
        // Check if user has synced within the subscription cache window
        const cached = await UserSubscriptions.findOne({ userId });
        if (cached && cached.fetchedAt) {
            if (Date.now() - new Date(cached.fetchedAt).getTime() < SUBSCRIPTION_CACHE_TTL_MS) {
                console.log(`[Sync] User ${userId} already synced within the last ${SUBSCRIPTION_CACHE_TTL_DAYS} days. Skipping.`);
                return res.json({ success: true, skipped: true, count: cached.totalCount });
            }
        }

        const channels = await syncUserChannels(userId, ytAccessToken);
        
        // Update the cache time in MongoDB so they aren't synced again for 30 days
        await UserSubscriptions.findOneAndUpdate(
            { userId },
            { 
                userId, 
                channels: channels.map(c => ({ id: c.id, title: c.title, description: c.description })),
                totalCount: channels.length,
                fetchedAt: new Date()
            },
            { upsert: true, new: true }
        );

        res.json({ success: true, count: channels.length, channels: channels.slice(0, 5) });
    } catch (err) {
        console.error('[Supabase Sync Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/youtube/search
// Searches for a semantic topic strictly against the local Supabase DB
app.get('/api/youtube/search', async (req, res) => {
    const { q, limit, userId } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });

    try {
        const results = await searchLocalVideos(q, parseInt(limit) || 5, userId);
        res.json({ results });
    } catch (err) {
        console.error('[Supabase Search Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`QuestMap API running on port ${PORT}`);
    // Start background YouTube RSS synchronization job
    startCron();
});

module.exports = app;
