require('dotenv').config();
const mongoose = require('mongoose');

// Import models
const Document = require('./models/Document');
const MasteryRecord = require('./models/MasteryRecord');
const Quest = require('./models/Quest');
const RepoAnalysis = require('./models/RepoAnalysis');
const RepoCodeBlock = require('./models/RepoCodeBlock');
const RepoFile = require('./models/RepoFile');
const UserPreferences = require('./models/UserPreferences');
const UserSubscriptions = require('./models/UserSubscriptions');

async function clearAnonymousData() {
    console.log('=== Clearing Anonymous User Data from MongoDB ===\n');

    if (!process.env.MONGODB_URI) {
        console.error('✗ MONGODB_URI not found in .env');
        process.exit(1);
    }

    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(process.env.MONGODB_URI);
        console.log('Connected to MongoDB.\n');

        const models = [
            { name: 'Document', model: Document },
            { name: 'MasteryRecord', model: MasteryRecord },
            { name: 'Quest', model: Quest },
            { name: 'RepoAnalysis', model: RepoAnalysis },
            { name: 'RepoCodeBlock', model: RepoCodeBlock },
            { name: 'RepoFile', model: RepoFile },
            { name: 'UserPreferences', model: UserPreferences },
            { name: 'UserSubscriptions', model: UserSubscriptions }
        ];

        for (const item of models) {
            const result = await item.model.deleteMany({ userId: 'anonymous' });
            console.log(`Deleted ${result.deletedCount} documents from ${item.name} collection.`);
        }

        console.log('\n✓ MongoDB anonymous data cleared successfully.');
    } catch (err) {
        console.error('✗ Error clearing anonymous data:', err.message);
    } finally {
        await mongoose.disconnect();
        console.log('Disconnected from MongoDB.');
        process.exit(0);
    }
}

clearAnonymousData();
