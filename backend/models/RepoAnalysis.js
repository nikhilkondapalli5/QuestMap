const mongoose = require('mongoose');

const RepoAnalysisSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    repoUrl: { type: String, required: true },
    repoFullName: { type: String, required: true, index: true },
    repoName: { type: String, required: true },
    defaultBranch: { type: String },
    commitSha: { type: String },
    skillLevel: { type: String, default: 'beginner' },
    evidence: { type: Object },
    analysis: { type: Object },
    codeIngestion: { type: Object },
    codeFiles: { type: Array, default: [] },
    status: { type: String, enum: ['ready', 'failed'], default: 'ready' },
    error: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
});

RepoAnalysisSchema.index({ userId: 1, repoFullName: 1, createdAt: -1 });

module.exports = mongoose.model('RepoAnalysis', RepoAnalysisSchema);
