const mongoose = require('mongoose');

const UserPreferencesSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    preferredDomains: [{ type: String }],
    deprioritizedDomains: [{ type: String }],
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('UserPreferences', UserPreferencesSchema);
