const express = require('express');
const cors = require('cors');
require('dotenv').config();
const mongoose = require('mongoose');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Quest = require('./models/Quest');
const Document = require('./models/Document');
const { initRAG, storeSessionContext, storeDocumentChunks, retrieveRelevantContext, retrieveCategorizedContext, formatRAGContext, chunkText } = require('./ragService');
const { parseFile, SUPPORTED_MIMETYPES } = require('./fileParser');

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

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

You never hallucinate URLs. When suggesting YouTube videos, you provide realistic search queries and estimated timestamp ranges based on typical tutorial structure, not fabricated links.`;

/**
 * Resolve a YouTube search query into a real video URL + title by scraping YouTube search results.
 * Parses ytInitialData JSON to get real videoId, title, and channel.
 * Falls back to YouTube search URL if scraping fails.
 */
async function resolveYouTubeVideo(searchQuery) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(
            `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`,
            {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            }
        );
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`YouTube returned ${res.status}`);

        const html = await res.text();

        // Try to parse ytInitialData for accurate title + channel
        const initDataMatch = html.match(/var ytInitialData = ({.*?});/s);
        if (initDataMatch) {
            try {
                const data = JSON.parse(initDataMatch[1]);
                const contents = data?.contents?.twoColumnSearchResultsRenderer
                    ?.primaryContents?.sectionListRenderer?.contents?.[0]
                    ?.itemSectionRenderer?.contents || [];

                for (const item of contents) {
                    const video = item.videoRenderer;
                    if (video?.videoId) {
                        return {
                            url: `https://www.youtube.com/watch?v=${video.videoId}`,
                            realTitle: video.title?.runs?.[0]?.text || null,
                            realChannel: video.ownerText?.runs?.[0]?.text || null,
                        };
                    }
                }
            } catch { /* fall through to regex approach */ }
        }

        // Fallback: regex for videoId only
        const matches = [...html.matchAll(/"videoId":"([^"]+)"/g)];
        const uniqueIds = [...new Set(matches.map(m => m[1]))];
        if (uniqueIds.length > 0) {
            return { url: `https://www.youtube.com/watch?v=${uniqueIds[0]}`, realTitle: null, realChannel: null };
        }
    } catch (err) {
        console.warn(`YouTube resolve failed for "${searchQuery}":`, err.message);
    }
    return { url: `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`, realTitle: null, realChannel: null };
}

/**
 * Resolve all YouTube search queries in resource data to real video URLs + titles.
 */
async function resolveYouTubeUrls(resourceData) {
    if (!resourceData?.youtube_videos?.length) return resourceData;

    const resolved = await Promise.all(
        resourceData.youtube_videos.map(async (video) => {
            const query = video.search_query || `${video.channel || ''} ${video.title || ''}`.trim();
            const result = await resolveYouTubeVideo(query);
            return {
                ...video,
                url: result.url,
                title: result.realTitle || video.title,           // Use real title if available
                channel: result.realChannel || video.channel,     // Use real channel if available
                search_query: query,
            };
        })
    );

    return { ...resourceData, youtube_videos: resolved };
}

/**
 * Resolve an article search query into a real URL + title by scraping DuckDuckGo HTML search results.
 * Extracts the first real result URL and its page title from DDG results.
 */
async function resolveArticleUrl(searchQuery) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(
            `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`,
            {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                }
            }
        );
        clearTimeout(timeout);
        if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);

        const html = await res.text();
        // DDG HTML: <a class="result__a" href="URL">TITLE</a>
        const resultPattern = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</g;
        const results = [...html.matchAll(resultPattern)];
        
        for (const match of results) {
            let url = match[1];
            let realTitle = match[2].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
            // DDG sometimes wraps URLs in //duckduckgo.com/l/?uddg=...
            if (url.includes('uddg=')) {
                url = decodeURIComponent(url.split('uddg=')[1].split('&')[0]);
            }
            // Skip google/youtube/DDG internal links
            if (!url.includes('google.com') && !url.includes('youtube.com') && !url.includes('duckduckgo.com')) {
                // Extract the source/domain from the URL
                let realSource = null;
                try { realSource = new URL(url).hostname.replace('www.', ''); } catch {}
                return { url, realTitle, realSource };
            }
        }
    } catch (err) {
        console.warn(`Article URL resolve failed for "${searchQuery}":`, err.message);
    }
    return { url: `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`, realTitle: null, realSource: null };
}

/**
 * Resolve all article search queries in resource data to real article URLs + titles.
 */
async function resolveArticleUrls(resourceData) {
    if (!resourceData?.articles?.length) return resourceData;

    const resolved = await Promise.all(
        resourceData.articles.map(async (article) => {
            const query = article.search_query || `${article.title || ''} ${article.source || ''}`.trim();
            const result = await resolveArticleUrl(query);
            return {
                ...article,
                url: result.url,
                title: result.realTitle || article.title,       // Use real title if available
                source: result.realSource || article.source,     // Use real source if available
                search_query: query,
            };
        })
    );

    return { ...resourceData, articles: resolved };
}

/**
 * Call Gemini with a prompt and return parsed JSON.
 * Uses responseMimeType for guaranteed structured output.
 */
async function callGemini(prompt, retries = 2) {
    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.7,
        },
    });

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const result = await model.generateContent(prompt);
            let text = result.response.text();
            text = text.replace(/```json|```/g, '').trim();
            return JSON.parse(text);
        } catch (err) {
            if (attempt === retries) throw err;
            console.warn(`Gemini attempt ${attempt + 1} failed, retrying...`);
        }
    }
}

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
            storeSessionContext(userId, { topic, skill_level, type: 'recommendations', node_label: 'overview', summary: `Generated ${json.recommendations?.length} recommendations for ${topic}` }).catch(() => {});
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

// ─── 4. Generate Practice Scenarios ─────────────────────────────────────────

app.post('/api/generate-practice', async (req, res) => {
    const { topic, node_label, skill_level, key_concepts, userId } = req.body;

    if (!topic || !node_label) {
        return res.status(400).json({ error: 'Topic and node_label are required' });
    }

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
            console.warn("RAG retrieval for practice failed:", e.message);
        }
    }

    const prompt = `${SYSTEM_PERSONA}
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

    try {
        console.log(`[${new Date().toISOString()}] Practice for: "${node_label}"`);
        const json = await callGemini(prompt);
        console.log(`[${new Date().toISOString()}] Generated ${json.scenarios?.length} practice scenarios.`);
        
        // Include debug context
        const _debug_context = {
            source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
            personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content }))
        };

        res.json({ ...json, _debug_context });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Practice Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate practice', details: error.message });
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

// ─── 5. Generate External Resources (YouTube Snippets + Articles) ──────────

app.post('/api/generate-resources', async (req, res) => {
    const { topic, node_label, skill_level, userId } = req.body;

    if (!topic || !node_label) {
        return res.status(400).json({ error: 'Topic and node_label are required' });
    }

    let referenceContext = '';
    let sourceMaterials = [];
    let contextMaterials = [];
    if (userId && process.env.PINECONE_API_KEY) {
        try {
            const results = await retrieveCategorizedContext(userId, `${topic} ${node_label}`, 5);
            sourceMaterials = results.sourceMaterials;
            contextMaterials = results.contextMaterials;

            if (sourceMaterials.length > 0 || contextMaterials.length > 0) {
                referenceContext = '\n\n### REFERENCE MATERIAL FROM UPLOADED DOCUMENTS (Use this to find relevant external resources):\n';
                [...sourceMaterials, ...contextMaterials].forEach(m => {
                    referenceContext += `- [${m.filename}]: ${m.content}\n`;
                });
            }
        } catch (e) {
            console.warn("RAG retrieval for resources failed:", e.message);
        }
    }

    const prompt = `${SYSTEM_PERSONA}
${referenceContext}

The learner is studying "${topic}", specifically the sub-topic: "${node_label}"
Skill level: "${skill_level || 'beginner'}"

### CRITICAL DOMAIN RELEVANCE GUARD
The following snippets were retrieved for the topic: "${topic}" and sub-topic: "${node_label}". 
- **STRICT MISMATCH CHECK**: If the snippets are about a very specific application (like "Video Summarization") while the user is learning a broad topic (like "Machine Learning"), you **MUST IGNORE** them.
- **AUTHORITY**: Only use this material if it is a DIRECT and NECESSARY match for "${node_label}". Otherwise, provide standard high-quality resources for "${topic}".
- If they ARE relevant:
  - Curate highly specific resources that complement the user's provided material.

CRITICAL RULES FOR YOUTUBE:
- Do NOT provide direct YouTube video URLs — they are often wrong.
- Instead, for each video provide a "search_query" that is VERY SPECIFIC: include the exact channel name AND a distinctive phrase from the video title. Example: "freeCodeCamp reinforcement learning full course 2024" or "3Blue1Brown neural networks chapter 1".
- The search query should be specific enough that the FIRST YouTube search result is the correct video.
- Provide estimated timestamp ranges for the most relevant section.

CRITICAL RULES FOR ARTICLES:
- Do NOT provide direct article URLs — they are often wrong and return 404 errors.
- Instead, provide the article title, the source website name, and a specific search_query that will find the actual article.
- Example: source "MDN Web Docs", search_query "MDN Array.prototype.map JavaScript"

Think step-by-step:
1. What are the best-known YouTube videos for this topic from channels like 3Blue1Brown, Fireship, Traversy Media, freeCodeCamp, Sentdex, Tech With Tim, The Coding Train, etc.?
2. What specific timestamp section covers this sub-topic?
3. What official documentation or tutorial articles are most relevant?

Return valid JSON matching this exact schema:
{
    "resources_for": "${node_label}",
    "youtube_videos": [
        {
            "id": 1,
            "search_query": "very specific YouTube search query including channel name and video title keywords",
            "channel": "Exact channel name",
            "title": "Exact or near-exact video title",
            "why_relevant": "Why this video helps with this specific sub-topic",
            "snippet_timestamp": "3:24 - 7:15",
            "snippet_description": "What is covered in this specific timestamp range",
            "skill_level": "beginner | intermediate | advanced"
        }
    ],
    "articles": [
        {
            "id": 1,
            "source": "Name of the site (e.g., MDN Web Docs, Official React Docs, GeeksforGeeks)",
            "search_query": "Specific search query to find this article on Google",
            "title": "Article or doc page title",
            "why_relevant": "How this article helps",
            "key_takeaway": "The one thing to learn from this resource",
            "estimated_read_time": "8 min"
        }
    ],
    "books": [
        {
            "title": "Book title",
            "author": "Author name",
            "relevant_chapter": "Chapter or section most relevant",
            "why_relevant": "Why this book helps"
        }
    ]
}

Provide exactly 4 YouTube videos, 3 articles, and 2 books.`;

    try {
        console.log(`[${new Date().toISOString()}] Resources for: "${node_label}"`);
        const json = await callGemini(prompt);
        console.log(`[${new Date().toISOString()}] Generated resources: ${json.youtube_videos?.length} videos, ${json.articles?.length} articles.`);

        // Resolve YouTube + Article search queries to real URLs (in parallel)
        console.log(`[${new Date().toISOString()}] Resolving resource URLs...`);
        const withYouTube = await resolveYouTubeUrls(json);
        const withArticles = await resolveArticleUrls(withYouTube);
        console.log(`[${new Date().toISOString()}] All resource URLs resolved.`);
        
        // Include debug context
        const _debug_context = {
            source: sourceMaterials.map(m => ({ filename: m.filename, content: m.content })),
            personal: contextMaterials.map(m => ({ filename: m.filename, content: m.content }))
        };

        res.json({ ...withArticles, _debug_context });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Resources Error:`, error.message);
        res.status(500).json({ error: 'Failed to generate resources', details: error.message });
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

// ─── 7. File Upload & Document Management ──────────────────────────────────

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
            await doc.save().catch(() => {});
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

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`QuestMap API running on port ${PORT}`);
});

module.exports = app;