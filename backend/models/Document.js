const mongoose = require('mongoose');

const DocumentSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    filename: { type: String, required: true },
    mimetype: { type: String, required: true },
    category: { type: String, enum: ['source', 'context'], default: 'source' },
    sourceType: { type: String, enum: ['file', 'url'], default: 'file' },
    sourceUrl: { type: String, default: null },
    accessMode: { type: String, default: 'full_text_allowed' },
    permissionBasis: { type: String, default: null },
    accessReason: { type: String, default: null },
    fileSize: { type: Number },
    chunkCount: { type: Number, default: 0 },
    textLength: { type: Number, default: 0 },
    status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },
    uploadedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Document', DocumentSchema);
