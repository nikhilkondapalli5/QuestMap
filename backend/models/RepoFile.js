const mongoose = require('mongoose');

const RepoFileSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    repoFullName: { type: String, required: true, index: true },
    repoUrl: { type: String, required: true },
    defaultBranch: { type: String },
    commitSha: { type: String, required: true, index: true },
    filePath: { type: String, required: true },
    language: { type: String, default: 'text' },
    content: { type: String, required: true },
    contentHash: { type: String, required: true, index: true },
    lineCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

RepoFileSchema.index({ userId: 1, repoFullName: 1, commitSha: 1, filePath: 1 }, { unique: true });

module.exports = mongoose.model('RepoFile', RepoFileSchema);
