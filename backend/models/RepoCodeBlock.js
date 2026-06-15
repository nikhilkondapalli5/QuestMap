const mongoose = require('mongoose');

const RepoCodeBlockSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    repoFullName: { type: String, required: true, index: true },
    repoUrl: { type: String, required: true },
    defaultBranch: { type: String },
    commitSha: { type: String, required: true, index: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, ref: 'RepoFile', required: true, index: true },
    filePath: { type: String, required: true },
    language: { type: String, default: 'text' },
    blockType: { type: String, default: 'block' },
    symbolName: { type: String, default: 'module' },
    startLine: { type: Number, required: true },
    endLine: { type: Number, required: true },
    snippet: { type: String, required: true },
    anchorStartLine: { type: Number, default: null },
    anchorEndLine: { type: Number, default: null },
    anchorSnippet: { type: String, default: '' },
    traceSymbolName: { type: String, default: '' },
    traceBlockType: { type: String, default: '' },
    traceStartLine: { type: Number, default: null },
    traceEndLine: { type: Number, default: null },
    traceSnippet: { type: String, default: '' },
    contentHash: { type: String, required: true, index: true },
    summary: { type: String, default: '' },
    vectorId: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
});

RepoCodeBlockSchema.index({ userId: 1, repoFullName: 1, commitSha: 1, contentHash: 1 }, { unique: true });
RepoCodeBlockSchema.index({ userId: 1, repoFullName: 1, commitSha: 1, filePath: 1 });

module.exports = mongoose.model('RepoCodeBlock', RepoCodeBlockSchema);
