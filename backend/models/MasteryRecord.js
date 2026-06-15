const mongoose = require('mongoose');

const MasteryRecordSchema = new mongoose.Schema({
    userId: { type: String, required: true, index: true },
    topic: { type: String, required: true, index: true },
    nodeLabel: { type: String, default: 'overall', index: true },
    activityType: { type: String, enum: ['practice', 'quiz'], required: true },
    itemId: { type: String, default: '' },
    itemType: { type: String, default: 'multiple_choice' },
    question: { type: String, default: '' },
    selectedAnswer: { type: mongoose.Schema.Types.Mixed },
    correctAnswer: { type: mongoose.Schema.Types.Mixed },
    isCorrect: { type: Boolean, required: true },
    concepts: { type: [String], default: [] },
    sourceFactIds: { type: [String], default: [] },
    confidence: { type: String, default: 'low' },
    validationStatus: { type: String, default: 'ungrounded_exploratory' },
    remediation: { type: Object, default: null },
    createdAt: { type: Date, default: Date.now, index: true },
});

MasteryRecordSchema.index({ userId: 1, topic: 1, nodeLabel: 1, createdAt: -1 });

module.exports = mongoose.model('MasteryRecord', MasteryRecordSchema);
