/**
 * UserSubscriptions Model
 * Caches a user's YouTube channel subscriptions for 30 days.
 * TTL index on `fetchedAt` auto-expires the document — MongoDB will delete
 * it after 2592000 seconds (30 days), triggering a fresh fetch on next request.
 */
const mongoose = require('mongoose');
const SUBSCRIPTION_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const ChannelSchema = new mongoose.Schema({
    id:          { type: String, required: true },  // YouTube channelId
    title:       { type: String, required: true },  // Channel display name
    description: { type: String, default: '' },     // Channel description (for topic filtering)
}, { _id: false });

const UserSubscriptionsSchema = new mongoose.Schema({
    userId:     { type: String, required: true, unique: true, index: true },
    channels:   { type: [ChannelSchema], default: [] },
    totalCount: { type: Number, default: 0 },      // Total subscriptions fetched
    fetchedAt:  { type: Date, default: Date.now, expires: SUBSCRIPTION_CACHE_TTL_SECONDS },
});

module.exports = mongoose.model('UserSubscriptions', UserSubscriptionsSchema);
