/**
 * RAG Service — Pinecone + Gemini Embeddings
 * Handles storing/retrieving learning session context and document chunks.
 */
const { Pinecone } = require('@pinecone-database/pinecone');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const PINECONE_INDEX_NAME = 'questmap';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSION = 3072;

let pineconeIndex = null;
let embeddingModel = null;

/**
 * Initialize Pinecone client and Gemini embedding model.
 */
async function initRAG() {
    if (pineconeIndex) return pineconeIndex;

    try {
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

        // Check if index exists, create if not
        const existingIndexes = await pc.listIndexes();
        const indexNames = (existingIndexes?.indexes || []).map(idx => idx.name);

        if (!indexNames.includes(PINECONE_INDEX_NAME)) {
            console.log(`Creating Pinecone index "${PINECONE_INDEX_NAME}"...`);
            await pc.createIndex({
                name: PINECONE_INDEX_NAME,
                dimension: EMBEDDING_DIMENSION,
                metric: 'cosine',
                spec: {
                    serverless: {
                        cloud: 'aws',
                        region: 'us-east-1',
                    },
                },
            });
            // Wait for index to be ready
            console.log('Waiting for index to initialize...');
            await new Promise(resolve => setTimeout(resolve, 30000));
        }

        pineconeIndex = pc.index(PINECONE_INDEX_NAME);
        console.log(`Pinecone index "${PINECONE_INDEX_NAME}" ready.`);

        // Initialize Gemini embedding model
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        embeddingModel = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });

        return pineconeIndex;
    } catch (err) {
        console.error('RAG initialization failed:', err.message);
        throw err;
    }
}

/**
 * Generate an embedding for a text string using Gemini.
 */
async function generateEmbedding(text) {
    if (!embeddingModel) await initRAG();

    const result = await embeddingModel.embedContent(text);
    return result.embedding.values;
}

/**
 * Detect if a text chunk is likely a citation list or bibliography.
 */
function isCitationHeavy(text) {
    // Patterns for dense citations like [1, 2], (Author, 2020), "Vol. 4", "pp. 123-456"
    const citationPatterns = [
        /\[\d+(,\s*\d+)*\]/g, // [1, 2, 3]
        /\(\w+,\s*\d{4}\)/g,  // (Smith, 2023)
        /pp\.\s*\d+-\d+/g,    // pp. 123-145
        /vol\.\s*\d+/gi,      // Vol. 4/vol. 4
        /doi:\s*10\.\d+/gi,   // DOI references
        /https?:\/\/[^\s]+/g, // URLs
    ];

    let matchCount = 0;
    citationPatterns.forEach(pattern => {
        const matches = text.match(pattern);
        if (matches) matchCount += matches.length;
    });

    // If more than 5 explicit citation markers in a 500-word chunk, it's likely a bibliography
    // OR if the chunk is very short and contains at least 2 markers.
    const words = text.split(/\s+/).length;
    const ratio = matchCount / words;

    return (matchCount > 5) || (words < 50 && matchCount >= 2);
}

/**
 * Split text into overlapping chunks for embedding.
 */
function chunkText(text, chunkSize = 500, overlap = 150) {
    const words = text.split(/\s+/);
    const chunks = [];

    for (let i = 0; i < words.length; i += chunkSize - overlap) {
        const chunk = words.slice(i, i + chunkSize).join(' ');
        
        // Quality Filters:
        // 1. Length check
        if (chunk.trim().length < 50) continue;
        
        // 2. Citation/Bibliography check
        if (isCitationHeavy(chunk)) {
            // console.log("[RAG] Discarding citation-heavy chunk");
            continue;
        }

        chunks.push(chunk);
    }
    return chunks;
}

/**
 * Store a learning session summary in Pinecone.
 * Called after generating recommendations/practice for a topic.
 */
async function storeSessionContext(userId, sessionData) {
    if (!pineconeIndex) await initRAG();

    const summary = `Topic: ${sessionData.topic}. Sub-topic: ${sessionData.node_label || 'general'}. ` +
        `Skill level: ${sessionData.skill_level || 'beginner'}. ` +
        `Session type: ${sessionData.type || 'exploration'}. ` +
        (sessionData.summary ? `Summary: ${sessionData.summary}` : '');

    try {
        const embedding = await generateEmbedding(summary);
        const vectorId = `session_${userId}_${Date.now()}`;

        await pineconeIndex.namespace('sessions').upsert({ records: [{
            id: vectorId,
            values: embedding,
            metadata: {
                userId,
                topic: sessionData.topic,
                node_label: sessionData.node_label || '',
                skill_level: sessionData.skill_level || 'beginner',
                type: sessionData.type || 'exploration',
                summary: summary.slice(0, 1000),
                timestamp: new Date().toISOString(),
            },
        }]});

        console.log(`Stored session context: ${vectorId}`);
        return vectorId;
    } catch (err) {
        console.warn('Failed to store session context:', err.message);
        return null;
    }
}

/**
 * Store document chunks in Pinecone after file upload.
 */
async function storeDocumentChunks(userId, documentId, chunks, filename, category = 'source') {
    if (!pineconeIndex) await initRAG();

    const vectors = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const embedding = await generateEmbedding(chunks[i]);
            vectors.push({
                id: `doc_${documentId}_chunk_${i}`,
                values: embedding,
                metadata: {
                    userId,
                    documentId,
                    category,
                    filename,
                    chunkIndex: i,
                    totalChunks: chunks.length,
                    content: chunks[i].slice(0, 1000),
                    timestamp: new Date().toISOString(),
                },
            });
        } catch (err) {
            console.warn(`Failed to embed chunk ${i}:`, err.message);
        }

        // Rate limit: small delay between embeddings
        if (i > 0 && i % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    if (vectors.length > 0) {
        // Upsert in batches of 100
        for (let i = 0; i < vectors.length; i += 100) {
            const batch = vectors.slice(i, i + 100);
            await pineconeIndex.namespace('documents').upsert({ records: batch });
        }
        console.log(`Stored ${vectors.length} document chunks for ${filename}`);
    }

    return vectors.length;
}

/**
 * Retrieve relevant context from Pinecone for a given query.
 * Searches both sessions and documents for the user.
 */
async function retrieveRelevantContext(userId, query, topK = 5) {
    if (!pineconeIndex) await initRAG();

    try {
        const queryEmbedding = await generateEmbedding(query);

        // Search sessions
        const sessionResults = await pineconeIndex.namespace('sessions').query({
            vector: queryEmbedding,
            topK: Math.ceil(topK / 2),
            includeMetadata: true,
            filter: { userId: { $eq: userId } },
        });

        // Search documents
        const docResults = await pineconeIndex.namespace('documents').query({
            vector: queryEmbedding,
            topK: Math.ceil(topK / 2),
            includeMetadata: true,
            filter: { userId: { $eq: userId } },
        });

        const sessions = (sessionResults.matches || [])
            .filter(m => m.score > 0.3)
            .map(m => ({
                type: 'session',
                score: m.score,
                ...m.metadata,
            }));

        const documents = (docResults.matches || [])
            .filter(m => m.score > 0.3)
            .map(m => ({
                type: 'document',
                score: m.score,
                ...m.metadata,
            }));

        return { sessions, documents };
    } catch (err) {
        console.warn('RAG retrieval failed:', err.message);
        return { sessions: [], documents: [] };
    }
}

/**
 * Retrieve specialized document context for Knowledge Map Generation.
 * Splits documents cleanly into 'source' and 'context' materials.
 */
async function retrieveCategorizedContext(userId, query, topK = 10) {
    if (!pineconeIndex) await initRAG();

    try {
        const queryEmbedding = await generateEmbedding(query);

        console.log(`[RAG DEBUG] Querying Pinecone for User: ${userId}, Topic: "${query}"`);
        const docResults = await pineconeIndex.namespace('documents').query({
            vector: queryEmbedding,
            topK: topK,
            includeMetadata: true,
            filter: { userId: { $eq: userId } },
        });

        console.log(`[RAG DEBUG] Raw matches found: ${docResults.matches?.length || 0}`);
        if (docResults.matches?.length > 0) {
            docResults.matches.forEach((m, i) => {
                console.log(`  - Match ${i}: Score: ${m.score.toFixed(4)}, File: ${m.metadata?.filename}`);
            });
        }

        const matches = (docResults.matches || [])
            .filter(m => m.score > 0.65) // Drastically increased from 0.45 to 0.65 to ensure strictly relevant context
            .map(m => ({
                score: m.score,
                ...m.metadata,
            }));

        const sourceMaterials = matches.filter(m => m.category === 'source');
        const contextMaterials = matches.filter(m => m.category === 'context');

        return { sourceMaterials, contextMaterials };
    } catch (err) {
        console.warn('Categorized RAG retrieval failed:', err.message);
        return { sourceMaterials: [], contextMaterials: [] };
    }
}

/**
 * Format retrieved context into a prompt section.
 */
function formatRAGContext(ragResults) {
    let contextBlock = '';

    if (ragResults.sessions.length > 0) {
        contextBlock += '\n### Learner\'s Past Learning History\n';
        ragResults.sessions.forEach((s, i) => {
            contextBlock += `${i + 1}. ${s.summary} (relevance: ${(s.score * 100).toFixed(0)}%)\n`;
        });
    }

    if (ragResults.documents.length > 0) {
        contextBlock += '\n### Relevant Content from Uploaded Documents\n';
        ragResults.documents.forEach((d, i) => {
            contextBlock += `${i + 1}. [From "${d.filename}", chunk ${d.chunkIndex + 1}/${d.totalChunks}]: ${d.content}\n`;
        });
    }

    return contextBlock;
}

module.exports = {
    initRAG,
    generateEmbedding,
    chunkText,
    storeSessionContext,
    storeDocumentChunks,
    retrieveRelevantContext,
    retrieveCategorizedContext,
    formatRAGContext,
};
