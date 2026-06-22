import React, { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, Circle, Play, Lock, Clock, ChevronDown, ChevronRight, Sparkles, Target, AlertTriangle } from 'lucide-react';

const STATUS_CONFIG = {
    completed: {
        color: 'from-emerald-500 to-emerald-600',
        border: 'border-emerald-500/50',
        bg: 'bg-emerald-500/10',
        text: 'text-emerald-400',
        glow: 'shadow-emerald-500/20',
        icon: CheckCircle,
        label: 'Completed',
        dot: 'bg-emerald-500',
    },
    in_progress: {
        color: 'from-blue-500 to-blue-600',
        border: 'border-blue-500/50',
        bg: 'bg-blue-500/10',
        text: 'text-blue-400',
        glow: 'shadow-blue-500/20',
        icon: Play,
        label: 'In Progress',
        dot: 'bg-blue-500',
    },
    recommended_next: {
        color: 'from-purple-500 to-violet-600',
        border: 'border-purple-500/50',
        bg: 'bg-purple-500/10',
        text: 'text-purple-400',
        glow: 'shadow-purple-500/30',
        icon: Sparkles,
        label: 'Recommended',
        dot: 'bg-purple-500',
    },
    not_started: {
        color: 'from-gray-600 to-gray-700',
        border: 'border-gray-600/30',
        bg: 'bg-gray-800/30',
        text: 'text-gray-500',
        glow: 'shadow-none',
        icon: Circle,
        label: 'Not Started',
        dot: 'bg-gray-600',
    },
};

const BLOOM_ICONS = {
    'Remember': '📝', 'Understand': '💡', 'Apply': '🛠️',
    'Analyze': '🔍', 'Evaluate': '⚖️', 'Create': '🚀',
};

const DIFFICULTY_COLORS = {
    beginner: 'text-green-400 bg-green-500/10 border-green-500/20',
    intermediate: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20',
    advanced: 'text-red-400 bg-red-500/10 border-red-500/20',
};

const CONFIDENCE_STYLES = {
    high: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    medium: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    low: 'border-gray-600/40 bg-gray-800/40 text-gray-400',
};

const REPO_CATEGORY_LABELS = {
    frontend: 'Interface & UX',
    backend: 'Application logic',
    data: 'Data & persistence',
    ai: 'ML / AI patterns',
    devops: 'Platform & delivery',
    testing: 'Quality & verification',
    architecture: 'System design',
    security: 'Security',
    domain: 'Domain concepts',
    other: 'General concepts',
};

const REPO_ROLE_LABELS = {
    api: 'API layer',
    ui: 'UI components',
    state: 'State management',
    data_model: 'Data models',
    service: 'Services',
    config: 'Configuration',
    test: 'Tests',
    implementation: 'Core implementation',
};

const getRepoCategoryLabel = (category) => REPO_CATEGORY_LABELS[category] || REPO_CATEGORY_LABELS.other;

const getRepoPhaseLabel = (pathOrder, totalNodes) => {
    const ratio = totalNodes > 1 ? (pathOrder - 1) / (totalNodes - 1) : 0;
    if (ratio < 0.34) return 'Context & prerequisites';
    if (ratio < 0.67) return 'Core implementation patterns';
    return 'Integration & extension';
};

/**
 * Group topic-mode nodes into positional stages (legacy topic paths).
 */
function groupTopicNodesIntoStages(nodes) {
    if (!nodes || nodes.length === 0) return [];

    const stages = [];
    let currentStage = { label: 'Foundations', nodes: [] };

    nodes.forEach((node, i) => {
        currentStage.nodes.push({ ...node, originalIndex: i });

        if (currentStage.nodes.length >= 3 && i < nodes.length - 1) {
            stages.push(currentStage);
            const stageNum = stages.length;
            const stageLabels = ['Foundations', 'Core Skills', 'Intermediate', 'Advanced', 'Mastery', 'Specialization'];
            currentStage = { label: stageLabels[stageNum] || `Stage ${stageNum + 1}`, nodes: [] };
        }
    });

    if (currentStage.nodes.length > 0) {
        stages.push(currentStage);
    }

    return stages;
}

function getNodePathOrder(node, nodes) {
    if (node.pathOrder != null) return node.pathOrder;
    const index = nodes.findIndex(item => item.id === node.id);
    return index >= 0 ? index + 1 : 0;
}

/**
 * Group repo nodes by architectural layer, ordered by learning-path position.
 */
function groupRepoNodesIntoStages(nodes) {
    if (!nodes || nodes.length === 0) return [];

    const sorted = [...nodes].sort((a, b) => getNodePathOrder(a, nodes) - getNodePathOrder(b, nodes));
    const totalNodes = sorted.length;
    const categoryGroups = new Map();

    sorted.forEach((node) => {
        const category = node.repoCategory || 'other';
        if (!categoryGroups.has(category)) categoryGroups.set(category, []);
        categoryGroups.get(category).push({
            ...node,
            originalIndex: nodes.findIndex(item => item.id === node.id),
        });
    });

    return [...categoryGroups.entries()]
        .map(([category, groupNodes]) => {
            const orderedNodes = groupNodes.sort((a, b) => getNodePathOrder(a, nodes) - getNodePathOrder(b, nodes));
            const minOrder = Math.min(...orderedNodes.map(n => getNodePathOrder(n, nodes)));
            const avgOrder = orderedNodes.reduce((sum, n) => sum + getNodePathOrder(n, nodes), 0) / orderedNodes.length;
            return {
                label: getRepoCategoryLabel(category),
                phaseLabel: getRepoPhaseLabel(Math.round(avgOrder), totalNodes),
                category,
                minOrder,
                nodes: orderedNodes,
            };
        })
        .sort((a, b) => a.minOrder - b.minOrder);
}

function groupNodesIntoStages(nodes, mapData) {
    const isRepoPath = mapData?.isRepoPath || mapData?.repo_summary || nodes?.some(node => node.repoConcept);
    if (isRepoPath) return groupRepoNodesIntoStages(nodes);
    return groupTopicNodesIntoStages(nodes);
}

// ─── Node Card ──────────────────────────────────────────────────────────────

const NodeCard = ({ node, isSelected, onSelect, index }) => {
    const config = STATUS_CONFIG[node.status] || STATUS_CONFIG.not_started;
    const StatusIcon = config.icon;
    const bloom = BLOOM_ICONS[node.bloom_level] || '📘';
    const isRepoNode = node.repoConcept;
    const roleLabel = node.codeRole ? REPO_ROLE_LABELS[node.codeRole] || node.codeRole : null;
    const confidenceStyle = CONFIDENCE_STYLES[node.confidence] || CONFIDENCE_STYLES.medium;

    return (
        <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.06, type: 'spring', damping: 20 }}
            onClick={() => onSelect(node)}
            className={`
                relative flex items-start gap-3 p-3.5 rounded-xl cursor-pointer
                border transition-all duration-300 group
                ${isSelected
                    ? `${config.border} ${config.bg} shadow-lg ${config.glow}`
                    : 'border-gray-700/30 bg-gray-800/20 hover:border-gray-600/50 hover:bg-gray-800/40'
                }
            `}
        >
            {/* Status icon */}
            <div className={`
                w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0
                bg-gradient-to-br ${config.color} shadow-md
                ${node.status === 'recommended_next' ? 'animate-pulse' : ''}
            `}>
                <StatusIcon className="w-4 h-4 text-white" />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-sm">{bloom}</span>
                    <h4 className={`text-xs font-semibold truncate ${isSelected ? 'text-white' : 'text-gray-300 group-hover:text-white'}`}>
                        {node.label}
                    </h4>
                </div>

                {isRepoNode && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                        {node.confidence && (
                            <span className={`rounded-full border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-widest ${confidenceStyle}`}>
                                {node.confidence}
                            </span>
                        )}
                        {roleLabel && (
                            <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[8px] font-bold text-gray-400">
                                {roleLabel}
                            </span>
                        )}
                        {node.codeClusterCount > 0 && (
                            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[8px] font-bold text-blue-300/80">
                                {node.codeClusterCount} code refs
                            </span>
                        )}
                    </div>
                )}

                {/* Expanded details when selected */}
                <AnimatePresence>
                    {isSelected && (node.key_concepts || node.why_now) && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                        >
                            <div className="mt-2 pt-2 border-t border-gray-700/30 space-y-2">
                                {node.why_now && (
                                    <p className="text-[10px] leading-relaxed text-gray-400">{node.why_now}</p>
                                )}
                                {node.key_concepts && (
                                    <div>
                                        <p className="text-[10px] text-gray-400 mb-1 font-medium">Key Concepts:</p>
                                        <div className="flex flex-wrap gap-1">
                                            {(node.key_concepts || []).slice(0, 5).map((concept, i) => (
                                                <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-md bg-gray-700/40 text-gray-400">
                                                    {concept}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Arrow indicator */}
            <div className="flex-shrink-0 mt-1">
                {isSelected
                    ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                    : <ChevronRight className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400" />
                }
            </div>
        </motion.div>
    );
};

// ─── Stage Section ──────────────────────────────────────────────────────────

const StageSection = ({ stage, stageIndex, selectedNode, onNodeSelect, totalStages }) => {
    const completedCount = stage.nodes.filter(n => n.status === 'completed').length;
    const progress = stage.nodes.length > 0 ? (completedCount / stage.nodes.length) * 100 : 0;

    return (
        <div className="relative">
            {/* Stage header */}
            <div className="flex items-center gap-3 mb-3">
                <div className={`
                    w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold
                    ${progress === 100
                        ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                        : progress > 0
                            ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                            : 'bg-gray-700/30 text-gray-500 border border-gray-600/30'
                    }
                `}>
                    {stageIndex + 1}
                </div>
                <div className="flex-1">
                    <h3 className="text-xs font-bold text-gray-300 uppercase tracking-wider">{stage.label}</h3>
                    {stage.phaseLabel && (
                        <p className="mt-0.5 text-[9px] font-bold uppercase tracking-widest text-gray-500">{stage.phaseLabel}</p>
                    )}
                    <div className="flex items-center gap-2 mt-0.5">
                        <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden max-w-[120px]">
                            <motion.div
                                initial={{ width: 0 }}
                                animate={{ width: `${progress}%` }}
                                transition={{ delay: stageIndex * 0.2, duration: 0.8 }}
                                className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full"
                            />
                        </div>
                        <span className="text-[10px] text-gray-500">{completedCount}/{stage.nodes.length}</span>
                    </div>
                </div>
            </div>

            {/* Nodes */}
            <div className="ml-3.5 border-l-2 border-gray-700/40 pl-5 space-y-2 pb-2">
                {stage.nodes.map((node, i) => (
                    <div key={node.id} className="relative">
                        {/* Connection dot */}
                        <div className={`absolute -left-[25px] top-4 w-2.5 h-2.5 rounded-full border-2 border-gray-900 ${STATUS_CONFIG[node.status]?.dot || 'bg-gray-600'}`} />

                        <NodeCard
                            node={node}
                            isSelected={selectedNode?.id === node.id}
                            onSelect={onNodeSelect}
                            index={stageIndex * 3 + i}
                        />
                    </div>
                ))}
            </div>

            {/* Connector arrow to next stage */}
            {stageIndex < totalStages - 1 && (
                <div className="flex justify-center -mb-1">
                    <div className="w-px h-4 bg-gradient-to-b from-gray-700/40 to-transparent" />
                </div>
            )}
        </div>
    );
};

export const RepoOverview = ({ mapData }) => {
    const [isOpen, setIsOpen] = useState(false);
    const summary = mapData?.repo_summary;
    if (!summary?.plain_english && !summary?.project_type) return null;

    const stack = Array.isArray(mapData?.detected_stack) ? mapData.detected_stack.slice(0, 15) : [];
    const confidence = summary?.confidence || 'medium';

    return (
        <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 transition-all duration-300">
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className="flex w-full items-start justify-between gap-3 text-left outline-none"
            >
                <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-black uppercase tracking-widest text-blue-300">Repository Overview</p>
                    <h3 className="mt-1 truncate text-sm font-bold text-white flex items-center gap-1.5">
                        {summary.project_type || mapData?.topic || 'GitHub repository'}
                        <ChevronDown className={`w-3.5 h-3.5 text-blue-300 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                    </h3>
                    {!isOpen && summary.plain_english && (
                        <p className="mt-2 text-xs leading-relaxed text-gray-400 truncate">
                            {summary.plain_english}
                        </p>
                    )}
                </div>
                <span className={`flex-shrink-0 rounded-full border px-2 py-1 text-[10px] font-black uppercase ${CONFIDENCE_STYLES[confidence] || CONFIDENCE_STYLES.medium}`}>
                    {confidence}
                </span>
            </button>

            <AnimatePresence initial={false}>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0, marginTop: 0 }}
                        animate={{ height: 'auto', opacity: 1, marginTop: 8 }}
                        exit={{ height: 0, opacity: 0, marginTop: 0 }}
                        className="overflow-hidden"
                    >
                        {summary.plain_english && (
                            <p className="text-xs leading-relaxed text-gray-400">
                                {summary.plain_english}
                            </p>
                        )}

                        {stack.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                {stack.map(item => (
                                    <span key={item} className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold text-gray-300">
                                        {item}
                                    </span>
                                ))}
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Main Component ─────────────────────────────────────────────────────────

const LearningPathMap = ({ mapData, selectedNode, onNodeSelect }) => {
    const stages = useMemo(() => groupNodesIntoStages(mapData?.nodes, mapData), [mapData]);

    const totalNodes = mapData?.nodes?.length || 0;
    const completedNodes = mapData?.nodes?.filter(n => n.status === 'completed').length || 0;
    const overallProgress = totalNodes > 0 ? (completedNodes / totalNodes) * 100 : 0;

    if (!mapData?.nodes?.length) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-3">
                <Target className="w-10 h-10 text-gray-600" />
                <p className="text-sm italic">Generate a knowledge map to see your learning path</p>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col">
            {/* Overall progress header */}
            <div className="px-4 pt-3 pb-2 border-b border-gray-700/30 flex-shrink-0">
                <div className="flex items-center justify-between mb-1.5">
                    <h2 className="text-xs font-bold text-gray-300 uppercase tracking-wider flex items-center gap-1.5">
                        <Target className="w-3.5 h-3.5 text-purple-400" />
                        Learning Path
                    </h2>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${overallProgress}%` }}
                        transition={{ duration: 1, ease: 'easeOut' }}
                        className="h-full bg-gradient-to-r from-purple-500 via-blue-500 to-emerald-500 rounded-full"
                    />
                </div>
            </div>

            {/* Scrollable path */}
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y px-4 py-4 space-y-4 scrollbar-thin scrollbar-thumb-gray-700 scrollbar-track-transparent mobile-scroll-y">
                {stages.map((stage, i) => (
                    <StageSection
                        key={i}
                        stage={stage}
                        stageIndex={i}
                        selectedNode={selectedNode}
                        onNodeSelect={onNodeSelect}
                        totalStages={stages.length}
                    />
                ))}
            </div>

            {/* Legend */}
            <div className="px-4 py-2 border-t border-gray-700/30 flex-shrink-0">
                <div className="flex flex-wrap gap-3 justify-center">
                    {Object.entries(STATUS_CONFIG).map(([key, config]) => (
                        <span key={key} className="flex items-center gap-1.5 text-[9px] text-gray-500">
                            <span className={`w-2 h-2 rounded-full ${config.dot}`} />
                            {config.label}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default LearningPathMap;
