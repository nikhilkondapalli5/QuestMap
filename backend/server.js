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
const dns = require('node:dns/promises');
const net = require('node:net');
const { GoogleGenAI } = require('@google/genai');
const Quest = require('./models/Quest');
const Document = require('./models/Document');
const MasteryRecord = require('./models/MasteryRecord');
const RepoAnalysis = require('./models/RepoAnalysis');
const RepoFile = require('./models/RepoFile');
const UserSubscriptions = require('./models/UserSubscriptions');
const UserPreferences = require('./models/UserPreferences');
const { initRAG, storeSessionContext, storeDocumentChunks, deleteDocumentVectors, retrieveRelevantContext, retrieveCategorizedContext, formatRAGContext, chunkText } = require('./ragService');
const { parseFile, SUPPORTED_MIMETYPES } = require('./fileParser');
const { syncUserChannels, searchLocalVideos } = require('./youtubeDiscoveryService');
const { startCron } = require('./youtubeSyncCron');
const { buildGroundingContext, scoreSourceTrust, validateMapJson, validatePracticeJson, validateQuizJson } = require('./groundingService');
const { analyzeRepoWithLlm } = require('./repoAnalyzerService');
const { ingestAndLinkRepoCode } = require('./codeConceptService');
const EVAL_SCENARIOS = require('./evalScenarios');

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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const rateLimitBuckets = new Map();
app.use('/api', (req, res, next) => {
    const key = `${req.ip || 'local'}:${req.path}`;
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = req.path.includes('generate') || req.path.includes('ingest') ? 30 : 120;
    const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) {
        bucket.count = 0;
        bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    rateLimitBuckets.set(key, bucket);

    if (bucket.count > maxRequests) {
        return res.status(429).json({ error: 'Too many requests. Please retry shortly.' });
    }

    next();
});

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

When suggesting YouTube videos, provide realistic search queries and broad watch-section guidance, not fabricated links or exact timestamps.`;

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

function selectImportantSearchKeywords(keyConcepts = [], limit = 2) {
    const selected = [];
    const values = Array.isArray(keyConcepts) ? keyConcepts : [keyConcepts];

    for (const concept of values) {
        const compacted = compactSearchText(concept);
        const wordCount = compacted.split(' ').filter(Boolean).length;
        if (!compacted || wordCount > 4) continue;

        selected.push(compacted);
        if (selected.length >= limit) break;
    }

    return selected;
}

function selectSpecialistSearchKeywords(keyConcepts = [], limit = 2) {
    const selected = [];
    const important = new Set(selectImportantSearchKeywords(keyConcepts, keyConcepts.length || 0));
    const values = Array.isArray(keyConcepts) ? keyConcepts : [keyConcepts];

    for (const concept of values) {
        const compacted = compactSearchText(concept);
        if (!compacted || important.has(compacted)) continue;
        if (selected.some(existing => hasMeaningfulOverlap(existing, compacted) || hasMeaningfulOverlap(compacted, existing))) continue;

        selected.push(compacted);
        if (selected.length >= limit) break;
    }

    return selected;
}

function buildYouTubeSearchQuery(topic, nodeLabel, keyConcepts = []) {
    const candidates = [
        compactSearchText(nodeLabel),
        ...selectImportantSearchKeywords(keyConcepts, 2),
    ].filter(Boolean);

    const baseQuery = candidates.slice(0, 3).join(' ') || compactSearchText(nodeLabel);
    return baseQuery.trim();
}

function buildArticleSearchQuery(topic, nodeLabel, keyConcepts = []) {
    const candidates = [
        compactSearchText(nodeLabel),
        ...selectImportantSearchKeywords(keyConcepts, 2),
    ].filter(Boolean);

    const baseQuery = candidates.slice(0, 3).join(' ') || compactSearchText(nodeLabel);
    return baseQuery.trim();
}

function normalizeVideoSuggestion(video) {
    const { snippet_timestamp, ...rest } = video;
    return {
        ...rest,
        suggested_section: video.suggested_section || (snippet_timestamp ? 'Suggested watch focus' : undefined),
    };
}

function buildResourceLearningTasks({ nodeLabel, youtubeVideos = [], articles = [], books = [] }) {
    const tasks = [];
    const addTask = (resource, type, index) => {
        const title = resource.title || resource.search_query || resource.relevant_chapter || `${type} resource`;
        tasks.push({
            id: `${type}_task_${index + 1}`,
            resource_id: resource.id || `${type}_${index + 1}`,
            resource_type: type,
            resource_title: title,
            task: `Use this ${type} to identify how it explains "${nodeLabel}" and write down one definition, one example, and one open question.`,
            evidence_instruction: 'Treat this as a learner verification task. The app has not ingested this resource content as factual evidence.',
            validation_status: 'metadata_guided_not_source_grounded',
            confidence: 'low',
            source_fact_ids: [],
        });
    };

    youtubeVideos.slice(0, 3).forEach((resource, index) => addTask(resource, 'youtube', index));
    articles.slice(0, 3).forEach((resource, index) => addTask(resource, 'article', index));
    books.slice(0, 2).forEach((resource, index) => addTask(resource, 'book', index));

    return tasks;
}

function normalizeConcepts(concepts = [], fallback = '') {
    const values = Array.isArray(concepts) ? concepts : [concepts];
    const normalized = values
        .map(value => String(value || '').trim())
        .filter(Boolean);
    if (normalized.length === 0 && fallback) normalized.push(fallback);
    return [...new Set(normalized)].slice(0, 8);
}

function calculateMasteryLevel(accuracy, totalAttempts) {
    if (totalAttempts < 3) return 'calibrating';
    if (accuracy >= 0.85) return 'mastered';
    if (accuracy >= 0.7) return 'proficient';
    if (accuracy >= 0.5) return 'developing';
    return 'needs_remediation';
}

function buildAdaptiveRemediation({ topic, nodeLabel, concepts = [], question = '', isCorrect }) {
    if (isCorrect) return null;

    const focusConcepts = normalizeConcepts(concepts, nodeLabel).slice(0, 3);
    const focusLabel = focusConcepts.join(', ') || nodeLabel || topic;

    return {
        status: 'active',
        focus_concepts: focusConcepts,
        title: `Repair: ${focusLabel}`,
        review_task: `Review the definition, example, and boundary conditions for ${focusLabel}.`,
        practice_task: `Create one new example and one non-example for ${focusLabel}, then explain why the original answer was wrong.`,
        resource_query: compactSearchText(`${topic} ${nodeLabel} ${focusLabel} explained`),
        reason: question
            ? `This remediation was triggered by a missed question: "${String(question).slice(0, 180)}".`
            : 'This remediation was triggered by a missed mastery item.',
        next_step: 'Retry a similar question after reviewing the source-backed explanation or an uploaded source.',
    };
}

async function getMasterySummary({ userId, topic, nodeLabel = null }) {
    if (!isMongoReady()) {
        return {
            persistent: false,
            total_attempts: 0,
            correct_attempts: 0,
            accuracy: 0,
            mastery_level: 'unavailable',
            weak_concepts: [],
            recent_remediations: [],
        };
    }

    const query = { userId, topic };
    if (nodeLabel) query.nodeLabel = nodeLabel;

    const attempts = await MasteryRecord.find(query).sort({ createdAt: -1 }).limit(120).lean();
    const totalAttempts = attempts.length;
    const correctAttempts = attempts.filter(item => item.isCorrect).length;
    const accuracy = totalAttempts ? correctAttempts / totalAttempts : 0;
    const missedConceptCounts = new Map();

    for (const attempt of attempts) {
        if (attempt.isCorrect) continue;
        for (const concept of normalizeConcepts(attempt.concepts, attempt.nodeLabel)) {
            missedConceptCounts.set(concept, (missedConceptCounts.get(concept) || 0) + 1);
        }
    }

    const weakConcepts = [...missedConceptCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([concept, misses]) => ({ concept, misses }));

    return {
        persistent: true,
        total_attempts: totalAttempts,
        correct_attempts: correctAttempts,
        accuracy: Number(accuracy.toFixed(2)),
        mastery_level: calculateMasteryLevel(accuracy, totalAttempts),
        weak_concepts: weakConcepts,
        recent_remediations: attempts
            .filter(item => item.remediation)
            .slice(0, 5)
            .map(item => item.remediation),
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

function mapYouTubeSearchItem(item, searchQuery, index, fromSubscription = false, originalRank = index + 1, viewCount = null, duration = null) {
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
        view_count: viewCount,
        duration: duration,
    };
}

async function searchYouTubeApiVideos(searchQuery, subscribedChannels = [], displayCount = YOUTUBE_DISPLAY_RESULT_COUNT, ytAccessToken = null) {
    if (!ytAccessToken && !process.env.YOUTUBE_API_KEY) {
        console.warn('Neither ytAccessToken nor YOUTUBE_API_KEY is available. Cannot fetch YouTube API search results.');
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

        const headers = {};
        if (ytAccessToken) {
            headers['Authorization'] = `Bearer ${ytAccessToken}`;
        } else {
            url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
        }

        const res = await fetch(url.toString(), { headers });
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

        // Fetch video statistics and contentDetails to get viewCount and duration
        const videoIds = items.map(c => c.item.id.videoId).filter(Boolean);
        const statsMap = new Map();
        if (videoIds.length > 0) {
            try {
                const statsUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
                statsUrl.searchParams.set('part', 'contentDetails,statistics');
                statsUrl.searchParams.set('id', videoIds.join(','));
                
                const statsHeaders = {};
                if (ytAccessToken) {
                    statsHeaders['Authorization'] = `Bearer ${ytAccessToken}`;
                } else {
                    statsUrl.searchParams.set('key', process.env.YOUTUBE_API_KEY);
                }
                
                const statsRes = await fetch(statsUrl.toString(), { headers: statsHeaders });
                if (statsRes.ok) {
                    const statsData = await statsRes.json();
                    for (const v of (statsData.items || [])) {
                        if (v.id) {
                            statsMap.set(v.id, {
                                viewCount: parseInt(v.statistics?.viewCount || '0', 10),
                                duration: v.contentDetails?.duration || null
                            });
                        }
                    }
                }
            } catch (statsErr) {
                console.warn('[YouTube API Search] Failed to fetch video statistics:', statsErr.message);
            }
        }

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

        // Filter to display at most 2 videos from the same channel
        const mergedMatches = [...selectedSubscribedMatches, ...regularMatches];
        const channelCounts = new Map();
        const filteredMatches = [];

        for (const candidate of mergedMatches) {
            const channelKey = getChannelKey(candidate.item);
            const count = channelCounts.get(channelKey) || 0;
            if (count < 2) {
                channelCounts.set(channelKey, count + 1);
                filteredMatches.push(candidate);
            }
        }

        return filteredMatches
            .slice(0, displayCount)
            .map((candidate, index) => {
                const stats = statsMap.get(candidate.item.id.videoId) || {};
                return mapYouTubeSearchItem(
                    candidate.item,
                    searchQuery,
                    index,
                    candidate.fromSubscription,
                    candidate.originalRank,
                    stats.viewCount || null,
                    stats.duration || null
                );
            });
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
                why_relevant: 'Matched from your subscribed channels.',
                suggested_section: null,
                snippet_description: video.description || null,
                skill_level: 'beginner | intermediate | advanced',
                from_subscription: true,
                source_bucket: 'subscription_local_search',
                match_confidence: 'local_subscription_semantic_match',
                thumbnail_url: video.thumbnail_url || null,
                published_at: video.published_at || null,
                view_count: video.view_count || null,
                duration: null,
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
                { upsert: true, returnDocument: 'after' }
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
    try { return JSON.parse(text); } catch { }

    // Fix trailing commas before } or ]
    let fixed = text.replace(/,\s*([\]}])/g, '$1');

    // Try again
    try { return JSON.parse(fixed); } catch { }

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

    try { return JSON.parse(fixed); } catch { }

    // Last resort: truncate to last valid closing brace/bracket and try
    const lastBrace = fixed.lastIndexOf('}');
    const lastBracket = fixed.lastIndexOf(']');
    const cutPoint = Math.max(lastBrace, lastBracket);
    if (cutPoint > 0) {
        const truncated = fixed.substring(0, cutPoint + 1);
        try { return JSON.parse(truncated); } catch { }
    }

    throw new Error('Unable to parse or repair JSON from model output');
}

const ROBOTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const robotsCache = new Map();

function getHostname(value) {
    try {
        return new URL(value).hostname.replace(/^www\./, '');
    } catch {
        return null;
    }
}

function isPrivateIPv4(ip) {
    const parts = String(ip).split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;

    const [a, b] = parts;
    return (
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 0)
    );
}

function isPrivateIPv6(ip) {
    const value = String(ip).toLowerCase();
    return value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:');
}

function isBlockedHostname(hostname) {
    const value = String(hostname || '').toLowerCase();
    return (
        value === 'localhost' ||
        value.endsWith('.localhost') ||
        value.endsWith('.local') ||
        value === 'metadata.google.internal'
    );
}

async function assertPublicHttpUrl(urlValue) {
    const parsed = new URL(urlValue);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Only http and https URLs are allowed');
    }

    if (parsed.username || parsed.password) {
        throw new Error('URLs with embedded credentials are not allowed');
    }

    if (isBlockedHostname(parsed.hostname)) {
        throw new Error('Private or local network URLs are not allowed');
    }

    const ipVersion = net.isIP(parsed.hostname);
    if (ipVersion === 4 && isPrivateIPv4(parsed.hostname)) {
        throw new Error('Private IPv4 URLs are not allowed');
    }
    if (ipVersion === 6 && isPrivateIPv6(parsed.hostname)) {
        throw new Error('Private IPv6 URLs are not allowed');
    }

    if (!ipVersion) {
        const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
        for (const record of records) {
            if ((record.family === 4 && isPrivateIPv4(record.address)) || (record.family === 6 && isPrivateIPv6(record.address))) {
                throw new Error('URL resolves to a private network address');
            }
        }
    }

    return parsed;
}

function isMongoReady() {
    return Boolean(process.env.MONGODB_URI) && mongoose.connection.readyState === 1;
}

function buildMasteryPromptSection(summary) {
    if (!summary || !summary.persistent || summary.total_attempts === 0) {
        return '\n### MASTERY HISTORY\nNo persisted mastery attempts are available yet.\n';
    }

    const weakConcepts = (summary.weak_concepts || [])
        .map(item => `${item.concept} (${item.misses} misses)`)
        .join(', ') || 'none';

    return `
### MASTERY HISTORY
Recent attempts: ${summary.correct_attempts}/${summary.total_attempts} correct (${Math.round((summary.accuracy || 0) * 100)}%).
Current mastery level: ${summary.mastery_level}.
Weak concepts to prioritize: ${weakConcepts}.
Use this to adjust statuses, recommendations, and remediation. Do not mark weak concepts as completed unless the learner has recovered in later attempts.
`;
}

function applyMasteryMarkersToMap(mapJson, masterySummary) {
    const weakTerms = (masterySummary?.weak_concepts || [])
        .flatMap(item => compactSearchText(item.concept).split(' '))
        .filter(Boolean);
    if (!weakTerms.length || !Array.isArray(mapJson.nodes)) return mapJson;

    return {
        ...mapJson,
        nodes: mapJson.nodes.map(node => {
            const nodeTerms = compactSearchText(`${node.label || ''} ${(node.key_concepts || []).join(' ')}`);
            const overlap = weakTerms.some(term => term.length > 3 && nodeTerms.includes(term));
            if (!overlap) return node;
            return {
                ...node,
                remediation_required: true,
                status: node.status === 'completed' ? 'in_progress' : node.status,
            };
        }),
    };
}

function extractHtmlMeta(html, finalUrl) {
    const titleMatch = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const canonicalMatch = String(html).match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    const ogImageMatch = String(html).match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const title = titleMatch ? decodeHtmlText(titleMatch[1]).trim() : null;
    const canonicalUrl = canonicalMatch
        ? new URL(canonicalMatch[1], finalUrl).toString()
        : finalUrl;

    return {
        title,
        canonicalUrl,
        image: ogImageMatch ? ogImageMatch[1].trim() : null,
    };
}

function parseRobotsAccess(robotsText, targetPath) {
    const groups = [];
    let current = null;

    for (const rawLine of String(robotsText || '').split(/\r?\n/)) {
        const line = rawLine.split('#')[0].trim();
        if (!line) continue;

        const [rawKey, ...rest] = line.split(':');
        const key = rawKey.trim().toLowerCase();
        const value = rest.join(':').trim();

        if (key === 'user-agent') {
            if (current && current.rules.length === 0) {
                current.agents.push(value.toLowerCase());
            } else {
                current = { agents: [value.toLowerCase()], rules: [] };
                groups.push(current);
            }
        } else if ((key === 'allow' || key === 'disallow') && current) {
            current.rules.push({ type: key, path: value });
        }
    }

    const matchingRules = [];
    for (const group of groups) {
        const applies = group.agents.some(agent => agent === '*' || agent.includes('questmap'));
        if (!applies) continue;
        for (const rule of group.rules) {
            if (!rule.path) continue;
            if (targetPath.startsWith(rule.path)) matchingRules.push(rule);
        }
    }

    if (!matchingRules.length) return true;
    matchingRules.sort((a, b) => b.path.length - a.path.length);
    return matchingRules[0].type !== 'disallow';
}

async function getUrlMetadataAccess(urlValue) {
    let parsed;
    try {
        parsed = await assertPublicHttpUrl(urlValue);
    } catch {
        return {
            canFetchMetadata: false,
            permission_basis: 'invalid_url',
            access_reason: 'The discovered URL could not be parsed or points to a blocked/private target, so only search metadata is used.',
        };
    }

    const cacheKey = parsed.origin;
    const cached = robotsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < ROBOTS_CACHE_TTL_MS) {
        if (cached.robotsText) {
            const allowed = parseRobotsAccess(cached.robotsText, parsed.pathname || '/');
            return {
                canFetchMetadata: allowed,
                permission_basis: allowed ? 'robots_allows_metadata_preview' : 'robots_disallows_metadata_preview',
                access_reason: allowed
                    ? 'Robots policy allows a lightweight metadata preview; article body content is not ingested.'
                    : 'Robots policy disallows fetching this path, so QuestMap uses search-result metadata only.',
            };
        }
        return {
            ...cached.policy,
        };
    }

    try {
        const robotsUrl = new URL('/robots.txt', parsed.origin);
        const robotsRes = await fetch(robotsUrl.toString(), {
            headers: { 'User-Agent': 'QuestMapAI/1.0 (+metadata preview only)' },
            signal: AbortSignal.timeout(2500),
        });

        if (!robotsRes.ok) {
            const policy = {
                canFetchMetadata: false,
                permission_basis: `robots_http_${robotsRes.status}`,
                access_reason: 'Robots policy was unavailable, so QuestMap uses search-result metadata only.',
            };
            robotsCache.set(cacheKey, { fetchedAt: Date.now(), robotsText: '', policy });
            return policy;
        }

        const robotsText = await robotsRes.text();
        const allowed = parseRobotsAccess(robotsText, parsed.pathname || '/');
        const policy = {
            canFetchMetadata: allowed,
            permission_basis: allowed ? 'robots_allows_metadata_preview' : 'robots_disallows_metadata_preview',
            access_reason: allowed
                ? 'Robots policy allows a lightweight metadata preview; article body content is not ingested.'
                : 'Robots policy disallows fetching this path, so QuestMap uses search-result metadata only.',
        };
        robotsCache.set(cacheKey, { fetchedAt: Date.now(), robotsText, policy });
        return policy;
    } catch (err) {
        const policy = {
            canFetchMetadata: false,
            permission_basis: 'robots_unavailable',
            access_reason: 'Robots policy could not be checked in time, so QuestMap uses search-result metadata only.',
        };
        robotsCache.set(cacheKey, { fetchedAt: Date.now(), robotsText: '', policy });
        return policy;
    }
}

async function getUrlIngestionAccess(urlValue) {
    const access = await getUrlMetadataAccess(urlValue);
    return {
        ...access,
        canIngestFullText: access.canFetchMetadata,
        access_mode: access.canFetchMetadata ? 'full_text_allowed' : 'metadata_only',
        access_reason: access.canFetchMetadata
            ? 'Robots policy allows fetching this URL for user-requested source ingestion.'
            : access.access_reason,
    };
}

async function resolveRedirectTarget(urlValue, maxRedirects = 5) {
    let currentUrl = String(urlValue || '');

    for (let i = 0; i < maxRedirects; i++) {
        await assertPublicHttpUrl(currentUrl);
        const response = await fetch(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'User-Agent': 'QuestMapAI/1.0 (+redirect resolution only)' },
            signal: AbortSignal.timeout(4000),
        });

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) return currentUrl;
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        return response.url || currentUrl;
    }

    return currentUrl;
}

function extractReadableTextFromHtml(html) {
    const htmlText = String(html || '');
    const contentMatch = htmlText.match(/<article[\s\S]*?<\/article>/i)
        || htmlText.match(/<main[\s\S]*?<\/main>/i)
        || [htmlText];

    return contentMatch[0]
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchUrlTextForIngestion(urlValue) {
    await assertPublicHttpUrl(urlValue);
    const access = await getUrlIngestionAccess(urlValue);
    if (!access.canIngestFullText) {
        return { access, text: '', mimetype: 'text/uri-list', title: getHostname(urlValue) || urlValue, byteLength: 0 };
    }

    const response = await fetch(urlValue, {
        headers: { 'User-Agent': 'QuestMapAI/1.0 (+user requested source ingestion)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
        throw new Error(`URL fetch failed with HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') || '0');
    const maxBytes = 3 * 1024 * 1024;
    if (contentLength > maxBytes) {
        throw new Error('URL content is too large to ingest. Maximum supported size is 3MB.');
    }

    const contentType = response.headers.get('content-type') || 'text/html';
    const finalUrl = response.url || urlValue;
    await assertPublicHttpUrl(finalUrl);
    let text = '';
    let mimetype = contentType.split(';')[0].trim().toLowerCase();

    if (mimetype.includes('pdf')) {
        const buffer = Buffer.from(await response.arrayBuffer());
        text = await parseFile(buffer, 'application/pdf', finalUrl);
        mimetype = 'application/pdf';
    } else if (mimetype.includes('text/plain')) {
        text = (await response.text()).slice(0, maxBytes);
        mimetype = 'text/plain';
    } else if (mimetype.includes('html') || mimetype === 'application/xhtml+xml') {
        const html = (await response.text()).slice(0, maxBytes);
        const meta = extractHtmlMeta(html, finalUrl);
        if (meta.canonicalUrl) access.finalUrl = meta.canonicalUrl;
        if (meta.title) access.title = meta.title;
        text = extractReadableTextFromHtml(html);
        mimetype = 'text/html';
    } else {
        throw new Error(`Unsupported URL content type: ${mimetype || contentType}`);
    }

    return {
        access: { ...access, finalUrl: access.finalUrl || finalUrl },
        text,
        mimetype,
        title: access.title || getHostname(access.finalUrl || finalUrl) || finalUrl,
        byteLength: Buffer.byteLength(text, 'utf8'),
    };
}

/**
 * Fetch only lightweight link metadata when robots policy permits it.
 * The app never ingests article body text from discovered web resources here.
 */
async function fetchLinkPreview(redirectUrl) {
    let resolvedUrl = redirectUrl;
    try {
        resolvedUrl = await resolveRedirectTarget(redirectUrl);
        const access = await getUrlMetadataAccess(resolvedUrl);
        if (!access.canFetchMetadata) {
            return {
                title: null,
                image: null,
                url: resolvedUrl,
                failed: false,
                access_mode: 'metadata_only',
                can_extract_facts: false,
                can_store_content: false,
                source_role: 'recommended_resource',
                ...access,
            };
        }

        const response = await fetch(resolvedUrl, {
            headers: { 'User-Agent': 'QuestMapAI/1.0 (+metadata preview only)' },
            signal: AbortSignal.timeout(4000)
        });

        if (!response.ok) throw new Error(`HTTP Error ${response.status}`);

        const html = await response.text();
        const meta = extractHtmlMeta(html, response.url);

        return {
            title: meta.title,
            image: meta.image,
            url: meta.canonicalUrl || response.url,
            failed: false,
            access_mode: 'metadata_only',
            can_extract_facts: false,
            can_store_content: false,
            source_role: 'recommended_resource',
            ...access,
        };
    } catch (err) {
        return {
            title: null,
            image: null,
            url: resolvedUrl,
            failed: false,
            access_mode: 'metadata_only',
            can_extract_facts: false,
            can_store_content: false,
            source_role: 'recommended_resource',
            permission_basis: 'metadata_preview_failed',
            access_reason: 'Metadata preview failed, so QuestMap uses search-result metadata only.',
        };
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
async function searchArticles(topic, node_label, userId, options = {}) {
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

        let query = buildArticleSearchQuery(topic, node_label, options.keyConcepts || []);
        try {
            const llmQueryPrompt = `You are a search query generator for developers.
Generate a single, highly effective search query to find educational articles, official documentation, tutorials, or guides for the following concept:
Concept: "${node_label}"
Broader Topic: "${topic}"
Related Keywords: ${JSON.stringify(options.keyConcepts || [])}

Instructions:
- The query should be optimized for a search engine (like Google) to find high-quality learning resources.
- Focus on the core meaning of the concept.
- CRITICAL: Make sure to include any key frameworks, libraries, languages, or tools (e.g., React, FastAPI, PyTorch, Scikit-learn, etc.) mentioned in the concept label or keywords.
- Keep the query concise (usually 4 to 10 words). Avoid long full sentences or conversational queries.

Return JSON in this format:
{
  "search_query": "your query here"
}`;

            const generated = await callGemini(llmQueryPrompt, 1).catch(() => null);
            if (generated && generated.search_query && generated.search_query.trim()) {
                query = generated.search_query.trim();
            }
        } catch (queryErr) {
            console.warn('[SearchArticles] LLM query generation failed, using fallback:', queryErr.message);
        }
        const keywordContext = `${node_label} ${topic}`;
        const relatedKeywords = selectImportantSearchKeywords(options.keyConcepts || [], 4, keywordContext);
        const specialistKeywords = selectSpecialistSearchKeywords(options.keyConcepts || [], 2, keywordContext);
        const broadKeywordGuidance = relatedKeywords.length
            ? ` Related important concept keywords for diversification only: ${relatedKeywords.join(', ')}. Do not make every result about these exact terms.`
            : '';
        const specialistKeywordGuidance = specialistKeywords.length
            ? ` Specialist terms for at most one or two advanced results: ${specialistKeywords.join(', ')}.`
            : '';
        const sourceIntent = options.sourceIntent || 'Find authoritative learning resources. Prefer official documentation, university pages, standards bodies, reputable technical docs, and high-signal educational articles. Return mostly broad beginner-to-intermediate topic resources; include at most one or two highly specific research or specialist articles when they are clearly useful.';
        console.log(`[SearchArticles] Query: "${query}"`);
        const response = await ai.models.generateContent({
            model: process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash-lite',
            contents: `Perform Google search for '${query}'. ${sourceIntent}${broadKeywordGuidance}${specialistKeywordGuidance}${prefsString}`,
            config: {
                temperature: 0.2,
                tools: [{ googleSearch: {} }]
            }
        });

        const meta = response.candidates?.[0]?.groundingMetadata;
        const chunks = meta?.groundingChunks || [];

        const articles = [];
        let idCounter = 1;

        const seenUrls = new Set();

        // Execute metadata checks in parallel for all URLs. Article bodies are not scraped or used as evidence.
        const previewPromises = chunks.map(async (chunk) => {
            if (chunk.web && chunk.web.uri) {
                const preview = await fetchLinkPreview(chunk.web.uri);
                const resolvedUrl = preview.url || chunk.web.uri;
                if (!preview.failed && resolvedUrl && !seenUrls.has(resolvedUrl)) {
                    seenUrls.add(resolvedUrl);
                    const domain = getHostname(resolvedUrl) || chunk.web.title || 'Web Resource';
                    const trust = scoreSourceTrust({
                        domain,
                        title: preview.title || chunk.web.title || '',
                        url: resolvedUrl,
                    });
                    return {
                        id: 0, // Assigned later
                        source: domain,
                        domain,
                        title: preview.title || chunk.web.title || domain,
                        url: resolvedUrl,
                        image: preview.image || null,
                        why_relevant: `Found via Google Search for ${query}`,
                        estimated_read_time: "5 min",
                        trust_tier: trust.trust_tier,
                        trust_score: trust.trust_score,
                        access_mode: preview.access_mode || 'metadata_only',
                        can_extract_facts: false,
                        can_store_content: false,
                        source_role: 'recommended_resource',
                        permission_basis: preview.permission_basis,
                        access_reason: preview.access_reason || 'Discovered URL metadata can recommend a resource, but article content was not ingested.',
                    };
                }
            }
            return null;
        });

        const results = await Promise.all(previewPromises);

        for (const res of results
            .filter(Boolean)
            .sort((a, b) => (b.trust_score || 0) - (a.trust_score || 0))) {
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

app.get('/api/eval-scenarios', (req, res) => {
    res.json({ scenarios: EVAL_SCENARIOS });
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

Node and keyword rules:
- Node labels should be reusable teachable concept areas, not project-specific tasks, setup chores, codebase exploration, or implementation walkthroughs.
- Key concepts must be ordered for learning-resource search. The first two key_concepts should be the most specific useful discriminator terms for that node.
- Do not use the first key_concept to simply restate the node label or repeat generic words already present in the label when more specific terms are available.
- Put concrete tools, datasets, model names, file formats, commands, and implementation details in key_concepts when they are evidence-backed and useful, rather than making the node label about setup or execution.

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
	            "key_concepts": ["specific search-useful term 1", "specific search-useful term 2", "other relevant concept"],
	            "prerequisites": [],
	            "source_fact_ids": ["fact_1"],
	            "confidence": "high | medium | low",
	            "coverage_score": "high | medium | low"
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

Use your curriculum-design knowledge for sequencing, prerequisites, Bloom's taxonomy, and learning progression.
Use SOURCE-BACKED FACTS only for factual/domain-specific claims. If sources are narrow or sparse, still create a pedagogically useful map, but mark unsupported or broad nodes with low confidence.

Mark 1-2 nodes as "recommended_next" — these are what the learner should focus on NOW. Nodes they likely already know (based on history) should be "completed". Ensure the graph is a connected DAG.`;

    try {
        console.log(`[${new Date().toISOString()}] Map generation for: "${topic}"`);
        const masterySummary = userId ? await getMasterySummary({ userId, topic }) : null;
        const masteryContext = buildMasteryPromptSection(masterySummary);

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
- **STRICT MISMATCH CHECK**: If the user is asking for a broad topic but the documents are about a very specific and narrow application, you **MUST IGNORE** the documents. Do not let narrow research papers skew a broad foundational curriculum.
- **AUTHORITY**: You have the absolute authority to discard all provided snippets if they do not directly align with "${topic}".
- If they ARE a direct match:
${sourceMaterials.length > 0 ? '  - Align the core nodes with the Source Material structure.' : ''}
${personalContextStr ? '  - Use Personal Context to identify gaps (e.g. from mistakes).' : ''}
` : '';

        let mapArticleSources = [];
        try {
            mapArticleSources = await searchArticles(topic, 'official documentation foundational overview curriculum', userId, {
                sourceIntent: 'Discover high-authority sources for scoping a learning map. Prefer official documentation, university course pages, standards bodies, textbooks, and reputable encyclopedic overviews. Do not look for random blog posts unless no authoritative source exists.',
            });
            console.log(`[${new Date().toISOString()}] Map source discovery found ${mapArticleSources.length} metadata-only sources.`);
        } catch (sourceErr) {
            console.warn('Map source discovery skipped:', sourceErr.message);
        }

        const mapGrounding = buildGroundingContext({
            topic,
            nodeLabel: 'knowledge map',
            sourceMaterials,
            contextMaterials,
            articles: mapArticleSources,
        });
        const fullPrompt = prompt + masteryContext + sourceContextStr + personalContextStr + ragInstructions + '\n' + mapGrounding.sourceManifestSection + '\n' + mapGrounding.promptSection;

        const rawMapJson = await callGemini(fullPrompt);
        const json = applyMasteryMarkersToMap(validateMapJson(rawMapJson, mapGrounding), masterySummary);
        console.log(`[${new Date().toISOString()}] Map generated with ${json.nodes?.length} nodes.`);

        // Attach retrieval context for transparency
        res.json({
            ...json,
            _debug_context: {
                source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
                personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content })),
                grounding_sources: mapGrounding.sources.map(({ content, ...source }) => source),
                mastery_summary: masterySummary,
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
- **STRICT MISMATCH CHECK**: If the user is asking for a broad topic but the documents are about a very specific and narrow application, you **MUST IGNORE** the documents. Do not let narrow research papers skew a broad foundational curriculum.
- **AUTHORITY**: You have the absolute authority to discard all provided snippets if they do not directly align with "${topic}".
- If they ARE relevant, follow these prioritize rules:
1. Generate 6 personalized next-step learning recommendations.
2. If "Source Material" chunks are relevant, ensure at least 3 recommendations are directly derived from that material.
3. If "Personal Context" chunks are relevant and indicate specific mistakes/weaknesses, prioritize those as "High".
4. If mastery history shows weak concepts or active remediation, make those the first high-priority recommendations.
5. For EACH recommendation:
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
        const masterySummary = userId ? await getMasterySummary({ userId, topic }) : null;
        const masteryContext = buildMasteryPromptSection(masterySummary);
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
        const fullPrompt = prompt + masteryContext + (ragContext ? `\n${ragContext}` : '');
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
            sessions: (ragResults?.sessions || []).map(s => ({ topic: s.topic, summary: s.summary })),
            mastery_summary: masterySummary,
        };

        res.json({ ...json, _debug_context });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Recommendations Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate recommendations', details: error.message });
    }
});

// ─── 4+5. MERGED: Generate Node Data (Practice + Resources in one call) ─────

app.post('/api/generate-node-data', async (req, res) => {
    const { topic, node_label, skill_level, key_concepts, userId, ytAccessToken, resource_query } = req.body;

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

    const initialGrounding = buildGroundingContext({
        topic,
        nodeLabel: node_label,
        keyConcepts: key_concepts,
        sourceMaterials,
        contextMaterials,
    });
    const nodeMasterySummary = userId ? await getMasterySummary({ userId, topic, nodeLabel: node_label }) : null;
    const nodeMasteryContext = buildMasteryPromptSection(nodeMasterySummary);

    // ── Build PRACTICE prompt ────────────────────────────────────────────────
    const practicePrompt = `${SYSTEM_PERSONA}
${referenceContext}
${nodeMasteryContext}
${initialGrounding.sourceManifestSection}
${initialGrounding.promptSection}

The learner is studying "${topic}" and is currently on the sub-topic: "${node_label}"
Skill level: "${skill_level || 'beginner'}"
Key concepts to test: ${JSON.stringify(key_concepts || [])}

Generate practice scenarios to test and reinforce their understanding.

### CRITICAL DOMAIN RELEVANCE GUARD
The following snippets were retrieved for the topic: "${topic}" and sub-topic: "${node_label}". 
- **STRICT MISMATCH CHECK**: If the snippets are about a very specific application while the user is learning a broader topic, you **MUST IGNORE** them.
- **AUTHORITY**: Only use this material if it is a DIRECT and NECESSARY match for "${node_label}". Otherwise, use standard educational best practices for "${node_label}".
- If they ARE relevant, follow these CRITICAL rules:
  - You MUST only test concepts and use terminology found in the ABOVE REFERENCE MATERIAL or directly intrinsic to "${node_label}". 
  - Do NOT introduce outside framework names or advanced jargon that is NOT in the reference material.
  - Design questions that test understanding of THIS material, not general trivia.
  - Every factual claim in a question, answer, explanation, solution, or key takeaway should be supported by source_fact_ids when source-backed facts are available.
  - If source-backed facts are unavailable, keep questions foundational and mark the scenario confidence as "low", validation_status as "ungrounded_exploratory", and source_fact_ids as [].
  - Never use metadata-only articles, videos, or books as factual evidence for an answer.

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
	            "explanation": "Detailed explanation of why this is correct and why other options are wrong",
	            "source_fact_ids": ["fact_1"],
	            "confidence": "high | medium | low",
	            "validation_status": "source_supported | needs_source_review | ungrounded_exploratory"
	        },
	        {
	            "id": 2,
	            "type": "scenario",
	            "difficulty": "intermediate",
	            "question": "A real-world scenario the learner must analyze",
	            "context": "Background context for the scenario",
	            "solution": "Step-by-step solution with reasoning",
	            "key_takeaway": "What the learner should remember from this",
	            "source_fact_ids": ["fact_1"],
	            "confidence": "high | medium | low",
	            "validation_status": "source_supported | needs_source_review | ungrounded_exploratory"
	        },
	        {
	            "id": 3,
	            "type": "code_challenge",
	            "difficulty": "intermediate",
	            "question": "A coding task description",
	            "starter_code": "// Starting code or pseudocode",
	            "solution_code": "// Complete solution",
	            "explanation": "Why this solution works",
	            "source_fact_ids": ["fact_1"],
	            "confidence": "high | medium | low",
	            "validation_status": "source_supported | needs_source_review | ungrounded_exploratory"
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
${initialGrounding.sourceManifestSection}

The learner is studying "${topic}", specifically the sub-topic: "${node_label}"
Skill level: "${skill_level || 'beginner'}"

### CRITICAL DOMAIN RELEVANCE GUARD
The following snippets were retrieved for the topic: "${topic}" and sub-topic: "${node_label}". 
- **STRICT MISMATCH CHECK**: If the snippets are about a very specific application while the user is learning a broader topic, you **MUST IGNORE** them.
- **AUTHORITY**: Only use this material if it is a DIRECT and NECESSARY match for "${node_label}". Otherwise, provide standard high-quality resources for "${topic}".
- If they ARE relevant:
  - Curate highly specific resources that complement the user's provided material.

Think step-by-step:
1. What official documentation, tutorials, or books are most relevant?
2. Which books would support this sub-topic at the learner's skill level?
3. Do NOT generate YouTube videos. The backend retrieves YouTube videos separately from real search APIs.
4. Do NOT claim you know the contents of discovered videos/articles unless the text is provided above. Recommend resources and broad learner actions only.

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
        const resourceSearchTarget = resource_query || node_label;
        let dynamicQuery = buildYouTubeSearchQuery(topic, resourceSearchTarget, key_concepts);
        try {
            const llmQueryPrompt = `You are a search query generator for developers.
Generate a single, highly effective search query to find educational videos, tutorials, articles, or documentation for the following concept:
Concept: "${node_label}"
Broader Topic: "${topic}"
Related Keywords: ${JSON.stringify(key_concepts || [])}

Instructions:
- The query should be optimized for search engines (like Google and YouTube) to find high-quality learning resources.
- Focus on the core meaning of the concept.
- CRITICAL: Make sure to include any key frameworks, libraries, languages, or tools (e.g., React, FastAPI, PyTorch, Scikit-learn, etc.) mentioned in the concept label or keywords.
- Keep the query concise (usually 4 to 10 words). Avoid long full sentences or conversational queries.

Return JSON in this format:
{
  "search_query": "your query here"
}`;

            const generated = await callGemini(llmQueryPrompt, 1).catch(() => null);
            if (generated && generated.search_query && generated.search_query.trim()) {
                dynamicQuery = generated.search_query.trim();
                console.log(`[Repo Resource Generation] Generated Dynamic Query: "${dynamicQuery}"`);
            }
        } catch (queryErr) {
            console.warn('[Repo Resource Generation] LLM query generation failed, using fallback:', queryErr.message);
        }

        console.log(`[${new Date().toISOString()}] Node data for: "${node_label}" (1 RAG lookup, parallel practice/resources/search with query: "${dynamicQuery}")`);

        const [rawPracticeJson, resourceJson, articlesList, subscriptionVideos, searchVideos] = await Promise.all([
            callGemini(practicePrompt),
            callGemini(resourcePrompt), // JSON format, no YouTube videos
            searchArticles(topic, node_label, userId, { keyConcepts: key_concepts, overrideQuery: dynamicQuery }), // Text format, YES Search Grounding
            searchSubscribedLocalVideos(dynamicQuery, userId, 3),
            searchYouTubeApiVideos(dynamicQuery, subscribedChannels, 8, ytAccessToken)
        ]);

        const grounding = buildGroundingContext({
            topic,
            nodeLabel: node_label,
            keyConcepts: key_concepts,
            sourceMaterials,
            contextMaterials,
            articles: articlesList,
        });
        const practiceJson = validatePracticeJson(rawPracticeJson, grounding);

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
        resourceJson.learning_tasks = buildResourceLearningTasks({
            nodeLabel: node_label,
            youtubeVideos: resourceJson.all_youtube_videos,
            articles: resourceJson.articles,
            books: resourceJson.books,
        });
        delete resourceJson.subscribed_videos;

        const verifiedSubscriptionCount = resourceJson.all_youtube_videos.filter(v => v.from_subscription).length;
        console.log(`[YouTube] Displaying ${subscriptionVideos.length} local subscription videos plus ${searchVideos.length} API search videos (${verifiedSubscriptionCount} subscription-related total).`);

        // Debug context
        const _debug_context = {
            source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
            personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content })),
            subscribed_channels: subscribedChannels.map(ch => ch.title),
            grounding_sources: grounding.sources.map(({ content, ...source }) => source),
            source_coverage: grounding.coverage,
            mastery_summary: nodeMasterySummary,
        };

        res.json({
            practice: { ...practiceJson, _debug_context },
            resources: {
                ...resourceJson,
                source_coverage: grounding.coverage,
                source_candidates: grounding.sources.map(({ content, ...source }) => source),
                _debug_context,
            }
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Node Data Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate node data', details: error.message });
    }
});




app.post('/api/generate-quiz', async (req, res) => {
    const { topic, skill_level, node_label, userId } = req.body;

    if (!topic) {
        return res.status(400).json({ error: 'Topic is required' });
    }

    const focusScope = node_label ? `specifically focusing on the sub-topic: "${node_label}"` : `covering the general domain`;

    let sourceMaterials = [];
    let contextMaterials = [];
    if (userId && process.env.PINECONE_API_KEY) {
        try {
            const results = await retrieveCategorizedContext(userId, `${topic} ${node_label || ''}`, 8);
            sourceMaterials = results.sourceMaterials;
            contextMaterials = results.contextMaterials;
        } catch (ragErr) {
            console.warn('Quiz RAG retrieval skipped:', ragErr.message);
        }
    }

    const grounding = buildGroundingContext({
        topic,
        nodeLabel: node_label || 'overall quiz',
        sourceMaterials,
        contextMaterials,
    });
    const masterySummary = userId ? await getMasterySummary({ userId, topic, nodeLabel: node_label || null }) : null;

    const prompt = `${SYSTEM_PERSONA}
${buildMasteryPromptSection(masterySummary)}
${grounding.sourceManifestSection}
${grounding.promptSection}

The learner is studying "${topic}", ${focusScope}.
Current Skill Level: "${skill_level || 'beginner'}".

Generate a Candy-Crush style progressive "Level Quiz" with exactly 5 levels. Each level must be slightly harder than the previous one. The goal is to test their mastery step-by-step.
If source-backed facts are available, every factual explanation and correct answer should cite source_fact_ids. If no facts are available, mark confidence low and validation_status ungrounded_exploratory.

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
            "failure_message": "Not quite! Remember that [brief explanation].",
            "source_fact_ids": ["fact_1"],
            "confidence": "high | medium | low",
            "validation_status": "source_supported | needs_source_review | ungrounded_exploratory"
        }
    ]
}

Ensure there are exactly 5 objects in the "levels" array, progressing from fundamental to advanced application. Provide EXACTLY 4 options for each question. "correct_index" must be an integer from 0 to 3.`;

    try {
        console.log(`[${new Date().toISOString()}] Generating Level Quiz for: "${topic}" ${node_label ? `(${node_label})` : ''}`);
        const rawJson = await callGemini(prompt);
        const json = validateQuizJson(rawJson, grounding);
        console.log(`[${new Date().toISOString()}] Generated ${json.levels?.length || 0} quiz levels.`);
        res.json({
            ...json,
            _debug_context: {
                source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
                personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content })),
                mastery_summary: masterySummary,
            },
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Quiz Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate quiz', details: error.message });
    }
});

// ─── Mastery Tracking & Adaptive Remediation ───────────────────────────────

app.post('/api/mastery/attempt', async (req, res) => {
    try {
        const {
            userId,
            topic,
            nodeLabel = 'overall',
            activityType = 'practice',
            itemId = '',
            itemType = 'multiple_choice',
            question = '',
            selectedAnswer,
            correctAnswer,
            isCorrect,
            concepts = [],
            sourceFactIds = [],
            confidence = 'low',
            validationStatus = 'ungrounded_exploratory',
        } = req.body;

        if (!userId || !topic || typeof isCorrect !== 'boolean') {
            return res.status(400).json({ error: 'userId, topic, and boolean isCorrect are required' });
        }

        const normalizedConcepts = normalizeConcepts(concepts, nodeLabel);
        const remediation = buildAdaptiveRemediation({
            topic,
            nodeLabel,
            concepts: normalizedConcepts,
            question,
            isCorrect,
        });

        if (!isMongoReady()) {
            return res.status(503).json({
                error: 'Mastery tracking requires MongoDB to be connected.',
                persistent: false,
                remediation,
                mastery_summary: await getMasterySummary({ userId, topic, nodeLabel }),
            });
        }

        const record = await MasteryRecord.create({
            userId,
            topic,
            nodeLabel,
            activityType,
            itemId: String(itemId || ''),
            itemType,
            question,
            selectedAnswer,
            correctAnswer,
            isCorrect,
            concepts: normalizedConcepts,
            sourceFactIds: Array.isArray(sourceFactIds) ? sourceFactIds : [],
            confidence,
            validationStatus,
            remediation,
        });

        const masterySummary = await getMasterySummary({ userId, topic, nodeLabel });
        res.json({
            saved: true,
            record_id: record._id,
            remediation,
            mastery_summary: masterySummary,
        });
    } catch (err) {
        console.error('[Mastery] Failed to record attempt:', err.message);
        res.status(500).json({ error: 'Failed to record mastery attempt', details: err.message });
    }
});

app.get('/api/mastery/summary/:userId', async (req, res) => {
    try {
        const { topic, nodeLabel } = req.query;
        if (!topic) return res.status(400).json({ error: 'topic query parameter is required' });

        const summary = await getMasterySummary({
            userId: req.params.userId,
            topic,
            nodeLabel: nodeLabel || null,
        });
        res.json(summary);
    } catch (err) {
        console.error('[Mastery] Failed to fetch summary:', err.message);
        res.status(500).json({ error: 'Failed to fetch mastery summary', details: err.message });
    }
});

app.post('/api/mastery/remediation-practice', async (req, res) => {
    try {
        const { userId, topic, nodeLabel = 'overall', concepts = [], skill_level = 'beginner' } = req.body;
        if (!userId || !topic) return res.status(400).json({ error: 'userId and topic are required' });

        const focusConcepts = normalizeConcepts(concepts, nodeLabel);
        const query = `${topic} ${nodeLabel} ${focusConcepts.join(' ')}`.trim();
        let sourceMaterials = [];
        let contextMaterials = [];

        if (process.env.PINECONE_API_KEY) {
            try {
                const results = await retrieveCategorizedContext(userId, query, 8);
                sourceMaterials = results.sourceMaterials;
                contextMaterials = results.contextMaterials;
            } catch (ragErr) {
                console.warn('Remediation RAG retrieval skipped:', ragErr.message);
            }
        }

        const grounding = buildGroundingContext({
            topic,
            nodeLabel,
            keyConcepts: focusConcepts,
            sourceMaterials,
            contextMaterials,
        });

        const prompt = `${SYSTEM_PERSONA}
${grounding.sourceManifestSection}
${grounding.promptSection}

Generate a short adaptive remediation drill for the learner.
Topic: "${topic}"
Node: "${nodeLabel}"
Skill level: "${skill_level}"
Focus concepts: ${JSON.stringify(focusConcepts)}

Rules:
- Generate exactly 3 multiple_choice scenarios.
- Questions must target misconceptions around the focus concepts.
- If source-backed facts are available, cite source_fact_ids.
- If no facts are available, keep questions foundational and mark them ungrounded_exploratory.

Return valid JSON:
{
  "practice_title": "Remediation: ${nodeLabel}",
  "scenarios": [
    {
      "id": 1,
      "type": "multiple_choice",
      "difficulty": "beginner | intermediate | advanced",
      "question": "Targeted misconception-check question",
      "options": ["A", "B", "C", "D"],
      "correct_answer": 0,
      "explanation": "Why the correct answer addresses the misconception",
      "source_fact_ids": ["fact_1"],
      "confidence": "high | medium | low",
      "validation_status": "source_supported | needs_source_review | ungrounded_exploratory"
    }
  ]
}`;

        const rawJson = await callGemini(prompt);
        const practiceJson = validatePracticeJson(rawJson, grounding);
        res.json({
            ...practiceJson,
            remediation_focus: focusConcepts,
        });
    } catch (err) {
        console.error('[Mastery] Failed to generate remediation practice:', err.message);
        res.status(500).json({ error: 'Failed to generate remediation practice', details: err.message });
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
            { upsert: true, returnDocument: 'after' }
        );
        res.json(prefs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GitHub Repo Concept Learning ───────────────────────────────────────────

app.post('/api/repo/analyze', async (req, res) => {
    try {
        const { userId, repoUrl, skillLevel = 'beginner' } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId is required' });
        if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

        if (isMongoReady()) {
            const normalizedUrl = String(repoUrl || '').trim();
            const existing = await RepoAnalysis.findOne({
                userId,
                $or: [
                    { repoUrl: normalizedUrl },
                    { repoFullName: normalizedUrl.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\/$/, '') }
                ],
                skillLevel,
                status: 'ready'
            }).sort({ createdAt: -1 }).lean();

            if (existing && existing.codeIngestion?.status !== 'failed') {
                console.log(`[Repo Analysis] Cache HIT for user ${userId}, repo ${repoUrl}, returning saved analysis.`);
                return res.json({
                    id: existing._id,
                    transient: false,
                    repo: {
                        url: existing.repoUrl,
                        fullName: existing.repoFullName,
                        name: existing.repoName,
                        defaultBranch: existing.defaultBranch,
                        commitSha: existing.commitSha,
                    },
                    scan: existing.evidence?.scan || null,
                    code_graph: existing.evidence?.codeGraph || null,
                    code_ingestion: existing.codeIngestion,
                    code_files: existing.codeFiles,
                    evidence: (existing.evidence?.items || []).map(({ id, type, value, detail, weight }) => ({ id, type, value, detail, weight })),
                    analysis: existing.analysis,
                });
            }
        }

        const result = await analyzeRepoWithLlm({
            repoUrl,
            skillLevel,
            callLlm: callGemini,
        });

        let codeIngestion = {
            status: isMongoReady() ? 'skipped' : 'unavailable',
            reason: isMongoReady() ? 'No source files selected for code evidence.' : 'MongoDB is required for repo code evidence storage.',
        };
        let codeFiles = (result.sourceFiles || []).map(file => ({
            filePath: file.path,
            language: file.path?.endsWith('.py') || file.path?.endsWith('.ipynb') ? 'python' : 'text',
        }));
        if (isMongoReady() && result.sourceFiles?.length) {
            try {
                const linked = await ingestAndLinkRepoCode({
                    userId,
                    repo: result.repo,
                    sourceFiles: result.sourceFiles,
                    concepts: result.analysis.concepts,
                    callLlm: callGemini,
                    codeGraph: result.codeGraph,
                });
                const codeRefsByConceptId = new Map(linked.concepts.map(concept => [concept.id, concept.code_references || []]));
                result.analysis = {
                    ...result.analysis,
                    concepts: linked.concepts,
                    learning_path: (result.analysis.learning_path || []).map(step => ({
                        ...step,
                        code_references: codeRefsByConceptId.get(step.concept_id) || [],
                    })),
                };
                codeIngestion = {
                    status: 'ready',
                    ...linked.ingestion,
                };
                codeFiles = linked.codeFiles || codeFiles;
            } catch (err) {
                console.warn('[Repo Code Evidence] Skipped:', err.message);
                codeIngestion = {
                    status: 'failed',
                    reason: err.message,
                };
            }
        }

        let saved = null;
        if (isMongoReady()) {
            saved = await RepoAnalysis.create({
                userId,
                repoUrl: result.repo.url,
                repoFullName: result.repo.fullName,
                repoName: result.repo.name,
                defaultBranch: result.repo.defaultBranch,
                commitSha: result.repo.commitSha,
                skillLevel,
	                evidence: {
	                    scan: result.scan,
	                    items: result.evidence,
	                    codeGraph: result.codeGraph,
	                },
                analysis: result.analysis,
                codeIngestion,
                codeFiles,
                status: 'ready',
            });
        }

        res.json({
            id: saved?._id || null,
            transient: !saved,
            repo: result.repo,
            scan: result.scan,
            code_graph: result.codeGraph,
            code_ingestion: codeIngestion,
            code_files: codeFiles,
            evidence: result.evidence.map(({ id, type, value, detail, weight }) => ({ id, type, value, detail, weight })),
            analysis: result.analysis,
        });
    } catch (err) {
        console.error('[Repo Analysis] Failed:', err.message);
        const status = /valid GitHub|Only github|owner and repository|GitHub request failed \(404\)/i.test(err.message) ? 400 : 500;
        res.status(status).json({ error: 'Failed to analyze repository', details: err.message });
    }
});

app.get('/api/repo/code/file/:fileId', async (req, res) => {
    try {
        if (!isMongoReady()) return res.status(503).json({ error: 'Repo code files require MongoDB.' });
        const file = await RepoFile.findById(req.params.fileId).lean();
        if (!file) return res.status(404).json({ error: 'Repo file not found' });
        res.json({
            id: file._id,
            repoFullName: file.repoFullName,
            repoUrl: file.repoUrl,
            commitSha: file.commitSha,
            filePath: file.filePath,
            language: file.language,
            lineCount: file.lineCount,
            content: file.content,
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch repo file', details: err.message });
    }
});

app.post('/api/repo/code/search', async (req, res) => {
    try {
        const { userId, repoFullName, keyword } = req.body;
        if (!userId || !repoFullName || !keyword) {
            return res.status(400).json({ error: 'Missing userId, repoFullName, or keyword' });
        }

        if (!isMongoReady()) {
            return res.status(503).json({ error: 'Database not available' });
        }

        const RepoAnalysis = require('./models/RepoAnalysis');
        const RepoCodeBlock = require('./models/RepoCodeBlock');

        let analysis = await RepoAnalysis.findOne({ userId, repoFullName, status: 'ready' })
            .sort({ createdAt: -1 })
            .lean();

        if (!analysis && userId !== 'anonymous') {
            analysis = await RepoAnalysis.findOne({ userId: 'anonymous', repoFullName, status: 'ready' })
                .sort({ createdAt: -1 })
                .lean();
        }

        if (!analysis || !analysis.commitSha) {
            return res.status(404).json({ error: 'No ready repository analysis found for this user' });
        }

        // Check if Pinecone is configured
        const isPineconeActive = !!process.env.PINECONE_API_KEY;
        let dbBlocks = [];
        let scoresMap = new Map();

        if (isPineconeActive) {
            console.log(`[Repo Code Search] Searching for keyword "${keyword}" in Pinecone...`);
            const { retrieveRepoCodeMatches } = require('./ragService');
            const matches = await retrieveRepoCodeMatches({
                userId: analysis.userId,
                repoFullName,
                commitSha: analysis.commitSha,
                query: keyword,
                topK: 20,
                minScore: 0.6,
            });

            if (matches && matches.length > 0) {
                const blockIds = matches.map(m => m.blockId).filter(Boolean);
                dbBlocks = await RepoCodeBlock.find({ _id: { $in: blockIds } }).lean();
                matches.forEach(m => {
                    scoresMap.set(String(m.blockId), m.score);
                });
            }
        } else {
            console.log(`[Repo Code Search] Pinecone not active. Running fallback regex search in MongoDB...`);
            const regex = new RegExp(keyword, 'i');
            dbBlocks = await RepoCodeBlock.find({
                userId: analysis.userId,
                repoFullName,
                commitSha: analysis.commitSha,
                $or: [
                    { symbolName: regex },
                    { snippet: regex },
                    { filePath: regex },
                ]
            }).limit(20).lean();
        }

        const references = dbBlocks.map(block => {
            const score = scoresMap.get(String(block._id)) || 0.8;
            return {
                blockId: String(block._id),
                fileId: String(block.fileId),
                filePath: block.filePath,
                language: block.language,
                blockType: block.blockType,
                symbolName: block.symbolName,
                startLine: block.startLine,
                endLine: block.endLine,
                snippet: block.snippet,
                anchorStartLine: block.anchorStartLine || block.startLine,
                anchorEndLine: block.anchorEndLine || block.endLine,
                anchorSnippet: block.anchorSnippet || block.snippet,
                summary: block.summary || '',
                relevance: score,
                score,
                reason: isPineconeActive ? `Retrieved via semantic search.` : `Matched keyword "${keyword}" lexically.`,
            };
        }).sort((a, b) => b.score - a.score);

        res.json({ references });
    } catch (err) {
        console.error('[Repo Code Search] Failed:', err.message);
        res.status(500).json({ error: 'Failed to search repo code', details: err.message });
    }
});

app.get('/api/repo/analysis/:id', async (req, res) => {
    try {
        if (!isMongoReady()) return res.status(503).json({ error: 'Repo analysis history requires MongoDB.' });
        const analysis = await RepoAnalysis.findById(req.params.id).lean();
        if (!analysis) return res.status(404).json({ error: 'Repo analysis not found' });
        if (req.query.userId && analysis.userId !== 'anonymous' && analysis.userId !== req.query.userId) {
            return res.status(403).json({ error: 'Not allowed to access this repo analysis' });
        }
        res.json(analysis);
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch repo analysis', details: err.message });
    }
});

async function callGeminiText(contents, systemInstruction) {
    const config = {
        temperature: 0.4,
        maxOutputTokens: 4096,
    };
    if (systemInstruction) {
        config.systemInstruction = systemInstruction;
    }

    const primaryModel = process.env.GEMINI_TEXT_MODEL || 'gemini-2.5-flash-lite';
    const models = [
        primaryModel,
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
    ].filter((value, index, self) => self.indexOf(value) === index);

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let lastError = null;

    for (const model of models) {
        let attempts = 3;
        let delayMs = 1000;
        
        for (let i = 0; i < attempts; i++) {
            try {
                console.log(`[Gemini Call] Model: ${model}, Attempt: ${i + 1}/${attempts}`);
                const response = await ai.models.generateContent({
                    model: model,
                    contents: contents,
                    config,
                });
                return response.text || '';
            } catch (err) {
                lastError = err;
                console.warn(`[Gemini Call] Error on model ${model}, attempt ${i + 1}:`, err.message);
                
                // If it is a bad request or unauthorized, don't keep retrying this model
                if (err.status === 400 || (err.message && err.message.includes('API key not valid'))) {
                    break;
                }
                
                if (i < attempts - 1) {
                    await delay(delayMs);
                    delayMs *= 2;
                }
            }
        }
    }

    throw new Error(`Gemini generation failed after trying all models. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
}


app.post('/api/repo/code/explain', async (req, res) => {
    try {
        const { 
            selectedSnippet, 
            filePath, 
            language, 
            surroundingContext, 
            topic, 
            skillLevel,
            history = [],
            allSnippets = []
        } = req.body;

        if (!selectedSnippet) {
            return res.status(400).json({ error: 'selectedSnippet is required' });
        }

        let snippetsContext = '';
        if (Array.isArray(allSnippets) && allSnippets.length > 0) {
            snippetsContext = `Here are the context of all matched code snippets from this file (${filePath}):\n\n` + 
                allSnippets.map((s, idx) => {
                    return `--- Snippet ${idx + 1} (Lines ${s.startLine}-${s.endLine}) ---\n${s.snippet}\n` +
                        (s.summary ? `Summary: ${s.summary}\n` : '') +
                        (s.reason ? `Reason: ${s.reason}\n` : '');
                }).join('\n') + '\n\n';
        }

        const systemInstruction = `You are an expert developer and a programming teacher. Your goal is to explain code selections clearly and help the user with follow-ups.
Explain the core logic of the selected code snippet and break down its primary components/parts clearly. Keep your explanation highly structured and concise. Avoid explaining trivial programming syntax (like what a keyword or assignment operator means). Focus directly on what the code logic does. Do NOT write a long essay or large walls of text; keep it brief, informative, and to the point.
Format your responses using clean, structured Markdown. Do not repeat the code itself unnecessarily, but highlight key segments.
Frame explanations for a learner at a ${skillLevel || 'beginner'} level, keeping in mind they are studying the topic "${topic || 'software development'}".`;

        let contents = [];
        if (!history || history.length === 0) {
            const prompt = `${snippetsContext}Please explain this selected code snippet:
\`\`\`${language || ''}
${selectedSnippet}
\`\`\`

File path: ${filePath || 'unknown file'}

Surrounding context of the file:
\`\`\`${language || ''}
${surroundingContext || 'No surrounding context available'}
\`\`\`

Briefly explain the key components and logic of this code snippet, and how it fits into the topic of "${topic || 'software development'}". Do not write a long essay or explain basic language keywords; keep the breakdown focused, structured, and direct.`;
            contents = [{ role: 'user', parts: [{ text: prompt }] }];
        } else {
            contents = history.map((msg, idx) => {
                let text = msg.parts?.[0]?.text || msg.text || '';
                if (idx === 0 && snippetsContext) {
                    text = snippetsContext + text;
                }
                return {
                    role: msg.role === 'model' ? 'model' : 'user',
                    parts: [{ text }]
                };
            });
        }

        const responseText = await callGeminiText(contents, systemInstruction);
        res.json({ responseText });
    } catch (err) {
        console.error('Code explanation error:', err);
        res.status(500).json({ error: 'Failed to generate code explanation', details: err.message });
    }
});

// ── RAG / Pinecone Document Management ────────────────────────────────────

const ingestionJobs = new Map();

function getPublicJob(job) {
    if (!job) return null;
    const { error, result, ...rest } = job;
    return {
        ...rest,
        error: error ? { message: error.message } : null,
        result: result || null,
    };
}

async function performUrlIngestion({ userId, url, category = 'source' }) {
    const parsedUrl = await assertPublicHttpUrl(url);
    const fetched = await fetchUrlTextForIngestion(parsedUrl.toString());

    if (!fetched.access.canIngestFullText) {
        const err = new Error('URL cannot be ingested as source text');
        err.statusCode = 403;
        err.access = fetched.access;
        throw err;
    }

    const canonicalSourceUrl = fetched.access.finalUrl || parsedUrl.toString();
    if (isMongoReady()) {
        const existing = await Document.findOne({ userId, sourceType: 'url', sourceUrl: canonicalSourceUrl });
        if (existing) {
            return {
                duplicate: true,
                document: {
                    id: existing._id,
                    filename: existing.filename,
                    sourceUrl: existing.sourceUrl,
                    status: existing.status,
                },
            };
        }
    }

    if (fetched.text.length < 500) {
        const err = new Error('Not enough readable text was found at this URL.');
        err.statusCode = 422;
        err.access = fetched.access;
        throw err;
    }

    const filename = `${fetched.title || parsedUrl.hostname} - URL source`;
    let doc = null;
    if (isMongoReady()) {
        doc = new Document({
            userId,
            category,
            filename,
            mimetype: fetched.mimetype,
            sourceType: 'url',
            sourceUrl: canonicalSourceUrl,
            accessMode: fetched.access.access_mode,
            permissionBasis: fetched.access.permission_basis,
            accessReason: fetched.access.access_reason,
            fileSize: fetched.byteLength,
            status: 'processing',
        });
        await doc.save();
    }

    const chunks = chunkText(fetched.text, 500, 100);
    let storedCount = 0;
    if (process.env.PINECONE_API_KEY && chunks.length > 0) {
        const docId = doc ? doc._id.toString() : `url_${Date.now()}`;
        try {
            storedCount = await storeDocumentChunks(userId, docId, chunks, filename, category);
        } catch (vectorErr) {
            console.warn('[URL Ingestion] Vector storage skipped:', vectorErr.message);
        }
    }

    if (doc) {
        doc.chunkCount = storedCount;
        doc.textLength = fetched.text.length;
        doc.status = 'ready';
        await doc.save();
    }

    return {
        duplicate: false,
        access: {
            access_mode: fetched.access.access_mode,
            permission_basis: fetched.access.permission_basis,
            access_reason: fetched.access.access_reason,
            can_ingest_full_text: true,
        },
        document: {
            id: doc?._id,
            filename,
            sourceUrl: canonicalSourceUrl,
            textLength: fetched.text.length,
            chunkCount: chunks.length,
            storedVectors: storedCount,
            status: 'ready',
        },
    };
}

app.post('/api/ingest-url-job', async (req, res) => {
    const { userId, url, category = 'source' } = req.body;
    if (!userId || !url) return res.status(400).json({ error: 'userId and url are required' });
    if (!['source', 'context'].includes(category)) return res.status(400).json({ error: 'category must be source or context' });

    const jobId = `url_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = {
        id: jobId,
        status: 'queued',
        userId,
        url,
        category,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    ingestionJobs.set(jobId, job);

    setTimeout(async () => {
        const current = ingestionJobs.get(jobId);
        if (!current) return;
        current.status = 'processing';
        current.updatedAt = new Date().toISOString();
        try {
            current.result = await performUrlIngestion({ userId, url, category });
            current.status = current.result.duplicate ? 'duplicate' : 'complete';
        } catch (err) {
            current.error = err;
            current.status = 'failed';
        }
        current.updatedAt = new Date().toISOString();
    }, 0);

    res.status(202).json({ job: getPublicJob(job) });
});

app.get('/api/ingest-url-job/:jobId', (req, res) => {
    const job = ingestionJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job: getPublicJob(job) });
});

app.post('/api/ingest-url', async (req, res) => {
    const { userId, url, category = 'source' } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!['source', 'context'].includes(category)) {
        return res.status(400).json({ error: 'category must be source or context' });
    }

    try {
        const result = await performUrlIngestion({ userId, url, category });
        if (result.duplicate) {
            return res.status(409).json({
                error: 'This URL has already been ingested.',
                document: result.document,
            });
        }

        return res.json({
            message: 'URL ingested and indexed successfully',
            access: result.access,
            document: result.document,
        });
    } catch (err) {
        console.error(`[${new Date().toISOString()}] URL Ingestion Error:`, err.message);
        const publicUrlError = /private|local|embedded credentials|http and https|resolves to a private/i.test(err.message);
        const statusCode = err.statusCode || (publicUrlError ? 400 : 500);
        return res.status(statusCode).json({
            error: statusCode === 500 ? 'Failed to ingest URL' : err.message,
            details: err.message,
            access: err.access ? {
                access_mode: err.access.access_mode,
                permission_basis: err.access.permission_basis,
                access_reason: err.access.access_reason,
                can_ingest_full_text: Boolean(err.access.canIngestFullText),
            } : undefined,
        });
    }
});

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
        const doc = await Document.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Document not found' });
        const requester = req.query.userId || req.body?.userId;
        if (!requester || requester !== doc.userId) {
            return res.status(403).json({ error: 'Not allowed to delete this document' });
        }
        let deletedVectors = 0;
        if (doc && process.env.PINECONE_API_KEY && doc.chunkCount > 0) {
            try {
                deletedVectors = await deleteDocumentVectors(doc._id.toString(), doc.chunkCount);
            } catch (vectorErr) {
                console.warn('[Document Delete] Vector cleanup failed:', vectorErr.message);
            }
        }
        await Document.findByIdAndDelete(req.params.id);
        res.json({ message: 'Document deleted', deletedVectors });
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
            { upsert: true, returnDocument: 'after' }
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`QuestMap API running on port ${PORT}`);
        // Start background YouTube RSS synchronization job
        startCron();
    });
}

app.searchYouTubeApiVideos = searchYouTubeApiVideos;
module.exports = app;
