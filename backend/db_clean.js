require('dotenv').config();
const mongoose = require('mongoose');
const { Pinecone } = require('@pinecone-database/pinecone');
const { createClient } = require('@supabase/supabase-js');

async function cleanDatabases() {
    console.log('=== Starting Database Clean-up ===\n');

    // 1. Clean MongoDB
    if (process.env.MONGODB_URI) {
        try {
            console.log('Connecting to MongoDB...');
            await mongoose.connect(process.env.MONGODB_URI);
            console.log('Connected to MongoDB.');

            const db = mongoose.connection.db;
            const collections = await db.listCollections().toArray();

            for (const coll of collections) {
                console.log(`Clearing collection: ${coll.name}...`);
                await db.collection(coll.name).deleteMany({});
            }
            console.log('✓ MongoDB cleared successfully.\n');
        } catch (err) {
            console.error('✗ Failed to clear MongoDB:', err.message);
        } finally {
            await mongoose.disconnect();
        }
    } else {
        console.log('MongoDB URI not found in .env, skipping.\n');
    }

    // 2. Clean Pinecone Vector DB
    if (process.env.PINECONE_API_KEY) {
        try {
            console.log('Connecting to Pinecone...');
            const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
            const indexName = 'questmap';
            const index = pc.index(indexName);
            console.log(`Connected to Pinecone index: "${indexName}".`);

            const namespaces = ['sessions', 'documents', 'repo_code'];
            for (const ns of namespaces) {
                console.log(`Clearing Pinecone namespace: "${ns}"...`);
                try {
                    await index.namespace(ns).deleteAll();
                } catch (nsErr) {
                    console.log(`  (Note: Namespace "${ns}" may already be empty or not initialized: ${nsErr.message})`);
                }
            }
            console.log('✓ Pinecone vector namespaces cleared successfully.\n');
        } catch (err) {
            console.error('✗ Failed to clear Pinecone:', err.message);
        }
    } else {
        console.log('Pinecone API Key not found in .env, skipping.\n');
    }

    // 3. Clean Supabase SQL Database
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
        try {
            console.log('Connecting to Supabase...');
            const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
            console.log('Connected to Supabase.');

            console.log('Clearing user_subscriptions...');
            await supabase.from('user_subscriptions').delete().neq('user_id', '');

            console.log('Clearing youtube_videos...');
            await supabase.from('youtube_videos').delete().neq('id', '');

            console.log('Clearing youtube_channels...');
            await supabase.from('youtube_channels').delete().neq('id', '');

            console.log('✓ Supabase tables cleared successfully.\n');
        } catch (err) {
            console.error('✗ Failed to clear Supabase:', err.message);
        }
    } else {
        console.log('Supabase URL or Key not found in .env, skipping.\n');
    }

    console.log('=== Database Clean-up Completed ===');
    process.exit(0);
}

cleanDatabases();
