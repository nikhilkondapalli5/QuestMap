import React from 'react';
import { motion } from 'framer-motion';
import { Zap, Clock, Target, ChevronRight, TrendingUp, AlertCircle } from 'lucide-react';

const PRIORITY_STYLES = {
    high: {
        badge: 'bg-red-500/20 text-red-400 border-red-500/30',
        icon: <Zap className="w-3.5 h-3.5" />,
        glow: 'hover:shadow-red-500/10',
    },
    medium: {
        badge: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
        icon: <TrendingUp className="w-3.5 h-3.5" />,
        glow: 'hover:shadow-amber-500/10',
    },
    low: {
        badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
        icon: <Target className="w-3.5 h-3.5" />,
        glow: 'hover:shadow-emerald-500/10',
    },
};

const DIFFICULTY_COLORS = {
    beginner: 'text-green-400',
    intermediate: 'text-yellow-400',
    advanced: 'text-red-400',
};

const RecommendationCard = ({ recommendation, index }) => {
    const style = PRIORITY_STYLES[recommendation.priority] || PRIORITY_STYLES.medium;

    return (
        <motion.div
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.08, duration: 0.4 }}
            className={`bg-gray-800/60 border border-gray-700/50 rounded-2xl p-5 hover:border-gray-600 transition-all hover:shadow-xl ${style.glow} group`}
        >
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${style.badge}`}>
                            {style.icon}
                            {recommendation.priority}
                        </span>
                        <span className={`text-[10px] font-medium ${DIFFICULTY_COLORS[recommendation.difficulty] || 'text-gray-400'}`}>
                            {recommendation.difficulty}
                        </span>
                    </div>
                    <h3 className="text-white font-semibold text-sm leading-snug group-hover:text-blue-300 transition-colors">
                        {recommendation.title}
                    </h3>
                </div>
                <ChevronRight className="w-4 h-4 text-gray-600 group-hover:text-gray-400 transition-colors mt-1 flex-shrink-0" />
            </div>

            {/* Description */}
            <p className="text-gray-400 text-xs leading-relaxed mb-3">
                {recommendation.description}
            </p>

            {/* Reason — the key differentiator */}
            <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-3 mb-3">
                <div className="flex items-start gap-2">
                    <AlertCircle className="w-3.5 h-3.5 text-blue-400 mt-0.5 flex-shrink-0" />
                    <p className="text-blue-300/80 text-[11px] leading-relaxed italic">
                        {recommendation.reason}
                    </p>
                </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between text-[10px] text-gray-500">
                <div className="flex items-center gap-3">
                    {recommendation.estimated_hours && (
                        <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {recommendation.estimated_hours}h
                        </span>
                    )}
                    {recommendation.related_to_goal && (
                        <span className="flex items-center gap-1">
                            <Target className="w-3 h-3" />
                            {recommendation.related_to_goal.length > 30 ? recommendation.related_to_goal.slice(0, 28) + '…' : recommendation.related_to_goal}
                        </span>
                    )}
                </div>
                {recommendation.prerequisites_met && (
                    <span className="text-green-500 font-medium">✓ Ready</span>
                )}
            </div>
        </motion.div>
    );
};

const RecommendationList = ({ recommendations }) => {
    if (!recommendations?.length) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <Target className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm italic">Select a topic to see personalized recommendations</p>
            </div>
        );
    }

    return (
        <div className="space-y-3 pr-1">
            {recommendations.map((rec, i) => (
                <RecommendationCard key={rec.id || i} recommendation={rec} index={i} />
            ))}
        </div>
    );
};

export { RecommendationCard, RecommendationList };
export default RecommendationList;
