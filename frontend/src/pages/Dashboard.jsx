import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Compass, Lightbulb, BookOpen, Youtube, LogOut, Clock, Brain, Sparkles, RefreshCw, Moon, Sun, GitBranch, Code, Maximize2, Minimize2, FileText, X, PanelRightClose, PanelRightOpen } from 'lucide-react';
import RecommendationList from '../components/RecommendationCard';
import PracticePanel from '../components/PracticePanel';
import ResourcePanel, { CodeEvidencePanel, MarkdownText } from '../components/ResourcePanel';
import RepoLearningPanel from '../components/RepoLearningPanel';
import LoadingState from '../components/LoadingState';
import TubesBackground from '../components/TubesBackground';
import LearningPathMap, { RepoOverview } from '../components/LearningPathMap';
import { cn } from '../lib/utils';
import { auth } from '../firebase';
import { API_BASE } from '../config/api';

const TABS = [
    { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, color: 'text-amber-400', accent: 'bg-amber-400' },
    { id: 'repo', label: 'Repo', icon: GitBranch, color: 'text-blue-400', accent: 'bg-blue-400' },
    { id: 'practice', label: 'Practice', icon: BookOpen, color: 'text-emerald-400', accent: 'bg-emerald-400' },
    { id: 'resources', label: 'Resources', icon: Youtube, color: 'text-red-400', accent: 'bg-red-400' },
];

const DASHBOARD_CACHE_VERSION = 'repo-source-map-v7';
const NODE_CACHE_VERSION = 'grounded-node-data-v3';
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 2000;
const MIN_MAP_WIDTH = 280;

const MasteryOverview = ({ summary }) => {
    if (!summary || summary.mastery_level === 'unavailable') return null;
    const accuracy = Math.round((summary.accuracy || 0) * 100);

    return (
        <div className="mb-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-black uppercase tracking-widest text-emerald-300">
                    Mastery: {summary.mastery_level}
                </span>
                <span className="text-[10px] font-bold text-emerald-200">{accuracy}%</span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                {summary.correct_attempts || 0}/{summary.total_attempts || 0} recent attempts correct.
                {summary.weak_concepts?.length > 0 ? ` Review: ${summary.weak_concepts.map(item => item.concept).join(', ')}` : ' No weak concepts logged yet.'}
            </p>
        </div>
    );
};

const getProfileSourceKey = (profile) => {
    const type = profile?.source_type || 'topic';
    const value = type === 'repo' ? (profile?.repo_url || profile?.topic || '') : (profile?.topic || '');
    return `${type}:${String(value).trim().toLowerCase()}`;
};

const buildEvidenceClusterMap = (codeGraph) => {
    const map = new Map();
    for (const cluster of codeGraph?.clusters || []) {
        if (cluster.evidence_id) map.set(cluster.evidence_id, cluster);
    }
    return map;
};

const resolveConceptCodeRole = (concept, evidenceClusterMap) => {
    const roles = (concept?.code_cluster_ids || [])
        .map(id => evidenceClusterMap.get(id)?.role)
        .filter(Boolean);
    if (!roles.length) return null;
    const counts = {};
    roles.forEach(role => { counts[role] = (counts[role] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
};

const getRepoBloomLevel = (concept, pathOrder, totalSteps) => {
    const prereqCount = (concept?.prerequisites || []).length;
    const hasCodeEvidence = (concept?.code_cluster_ids || []).length > 0;
    const ratio = totalSteps > 1 ? (pathOrder - 1) / (totalSteps - 1) : 0;
    if (ratio >= 0.75 && hasCodeEvidence) return 'Create';
    if (ratio >= 0.6 || (hasCodeEvidence && prereqCount >= 2)) return 'Evaluate';
    if (ratio >= 0.45 || hasCodeEvidence) return 'Analyze';
    if (ratio >= 0.3 || prereqCount >= 1) return 'Apply';
    if (prereqCount > 0) return 'Understand';
    return 'Remember';
};

const getRepoEstimatedHours = (concept) => {
    const keywordCount = Array.isArray(concept?.keywords) ? concept.keywords.length : 0;
    const goalCount = Array.isArray(concept?.learning_goals) ? concept.learning_goals.length : 0;
    const evidenceCount = Array.isArray(concept?.evidence_ids) ? concept.evidence_ids.length : 0;
    const base = concept?.confidence === 'low' ? 2 : 3;
    return Math.min(8, base + Math.min(3, Math.ceil((keywordCount + goalCount + evidenceCount) / 4)));
};

const getRepoMeta = (repoResult) => {
    const repo = repoResult?.repo || {};
    return {
        url: repo.url || repoResult?.repoUrl || '',
        fullName: repo.fullName || repoResult?.repoFullName || 'GitHub repo',
        name: repo.name || repoResult?.repoName || 'repo',
        defaultBranch: repo.defaultBranch || repoResult?.defaultBranch || '',
        commitSha: repo.commitSha || repoResult?.commitSha || '',
    };
};

const buildRepoMapData = (repoResult, skillLevel) => {
    const concepts = repoResult?.analysis?.concepts || [];
    const repoMeta = getRepoMeta(repoResult);
    const codeGraph = repoResult?.code_graph || repoResult?.codeGraph || null;
    const codeIngestion = repoResult?.code_ingestion || repoResult?.codeIngestion || null;
    const codeFiles = repoResult?.code_files || repoResult?.codeFiles || [];
    const evidenceClusterMap = buildEvidenceClusterMap(codeGraph);
    const conceptById = new Map(concepts.map(concept => [concept.id, concept]));
    const path = repoResult?.analysis?.learning_path?.length
        ? repoResult.analysis.learning_path
        : concepts.map((concept, index) => ({ order: index + 1, concept_id: concept.id, title: concept.title }));

    const totalSteps = path.length;

    const nodes = path
        .map((step, index) => {
            const concept = conceptById.get(step.concept_id);
            if (!concept) return null;
            const pathOrder = step.order ?? index + 1;
            return {
                id: `repo:${repoMeta.fullName}:${concept.id}`,
                label: concept.title,
                status: index === 0 ? 'recommended_next' : 'not_started',
                bloom_level: getRepoBloomLevel(concept, pathOrder, totalSteps),
                difficulty: skillLevel || 'beginner',
                estimated_hours: getRepoEstimatedHours(concept),
                key_concepts: (concept.keywords || concept.tools || []).slice(0, 8),
                learning_goals: concept.learning_goals || [],
                prerequisites: concept.prerequisites || [],
                topicOverride: concept.title,
                resourceQuery: concept.resource_query,
                repoConcept: true,
                repoCategory: concept.category || 'other',
                confidence: concept.confidence || 'medium',
                codeRole: resolveConceptCodeRole(concept, evidenceClusterMap),
                pathOrder,
                why_now: step.why_now || '',
                codeClusterCount: (concept.code_cluster_ids || []).length,
                repoFullName: repoMeta.fullName,
                why_relevant: concept.why_relevant,
                practice_focus: concept.practice_focus,
                search_query: concept.search_query || step.search_query || '',
                code_references: concept.code_references || step.code_references || [],
                code_ingestion: codeIngestion,
                code_files: codeFiles,
            };
        })
        .filter(Boolean);

    return {
        topic: repoMeta.fullName,
        title: `Concept path for ${repoMeta.fullName}`,
        total_estimated_hours: nodes.reduce((sum, node) => sum + (node.estimated_hours || 0), 0),
        nodes,
        edges: [],
        isRepoPath: true,
        repo_summary: repoResult.analysis?.repo_summary,
        detected_stack: repoResult.analysis?.detected_stack || [],
    };
};

const buildRepoProfileData = (repoResult, skillLevel) => {
    const concepts = repoResult?.analysis?.concepts || [];
    const repoMeta = getRepoMeta(repoResult);
    return {
        topic: repoMeta.fullName || 'GitHub repo concepts',
        skill_level: skillLevel || 'beginner',
        learner_summary: repoResult.analysis?.repo_summary?.plain_english || 'A repo-based concept learning path was generated.',
        estimated_total_hours: concepts.reduce((sum, concept) => sum + getRepoEstimatedHours(concept), 0),
        recommended_pace: skillLevel === 'advanced' ? 'accelerated' : 'steady',
        learning_history: [],
        knowledge_gaps: concepts
            .flatMap(concept => concept.prerequisites || [])
            .slice(0, 8),
    };
};

const buildRepoRecommendations = (repoResult, skillLevel) => {
    const concepts = repoResult?.analysis?.concepts || [];
    const repoMeta = getRepoMeta(repoResult);
    return concepts.slice(0, 6).map((concept, index) => ({
        id: `repo-rec-${concept.id}`,
        priority: index < 2 ? 'high' : 'medium',
        difficulty: skillLevel || 'beginner',
        title: `Study ${concept.title}`,
        description: (concept.learning_goals || []).slice(0, 2).join(' ') || concept.practice_focus || `Build general understanding of ${concept.title}.`,
        reason: concept.why_relevant,
        estimated_hours: getRepoEstimatedHours(concept),
        related_to_goal: repoMeta.fullName,
        prerequisites_met: index === 0,
    }));
};

const ReadmeModal = ({ isOpen, onClose, readmeContent, isLightTheme }) => {
    if (!isOpen || !readmeContent) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div 
                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                onClick={onClose}
            />
            
            <div className={`relative w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-3xl border shadow-2xl flex flex-col ${
                isLightTheme
                    ? 'bg-white border-gray-200 text-gray-900'
                    : 'bg-[#15171e] border-white/10 text-white'
            }`}>
                {/* Floating absolute-positioned close button */}
                <button 
                    type="button" 
                    onClick={onClose}
                    className={`absolute top-4 right-4 z-50 p-1.5 rounded-lg transition-colors border ${
                        isLightTheme
                            ? 'bg-white hover:bg-gray-100 text-gray-500 hover:text-gray-900 border-gray-200 shadow-sm'
                            : 'bg-[#15171e] hover:bg-white/10 text-gray-400 hover:text-white border-white/10'
                    }`}
                    title="Close README"
                >
                    <X className="w-4 h-4" />
                </button>
                
                <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                        <MarkdownText text={readmeContent} />
                    </div>
                </div>
            </div>
        </div>
    );
};

const Dashboard = () => {
    const navigate = useNavigate();

    // Profile state
    const [profile, setProfile] = useState(null);
    const [profileData, setProfileData] = useState(null);

    // Data states
    const [mapData, setMapData] = useState(null);
    const [recommendations, setRecommendations] = useState(null);
    const [practiceData, setPracticeData] = useState(null);
    const [resourceData, setResourceData] = useState(null);
    const [masteryOverview, setMasteryOverview] = useState(null);
    const [repoAnalysis, setRepoAnalysis] = useState(null);

    // UI states
    const [selectedNode, setSelectedNode] = useState(null);
    const [activeTab, setActiveTab] = useState(() => {
        try {
            const stored = sessionStorage.getItem('questmap_profile');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (parsed.source_type === 'repo') return 'repo';
            }
        } catch (e) {}
        return 'resources';
    });
    const [activeRepoSubtab, setActiveRepoSubtab] = useState('code');
    const [panelWidth, setPanelWidth] = useState(() => {
        const saved = Number(sessionStorage.getItem('questmap_panel_width'));
        if (Number.isFinite(saved) && saved >= MIN_PANEL_WIDTH) {
            return saved;
        }
        if (typeof window !== 'undefined') {
            const initialDefault = Math.round(window.innerWidth * 0.5);
            const viewportLimit = Math.max(MIN_PANEL_WIDTH, Math.min(window.innerWidth * 0.85, window.innerWidth - MIN_MAP_WIDTH));
            return Math.min(Math.max(initialDefault, MIN_PANEL_WIDTH), Math.min(MAX_PANEL_WIDTH, viewportLimit));
        }
        return DEFAULT_PANEL_WIDTH;
    });
    const [isResizingPanel, setIsResizingPanel] = useState(false);
    const [isPanelMaximized, setIsPanelMaximized] = useState(false);
    const [isSidePanelVisible, setIsSidePanelVisible] = useState(() => {
        return sessionStorage.getItem('questmap_side_panel_visible') !== 'false';
    });
    const [theme, setTheme] = useState(() => sessionStorage.getItem('questmap_theme') || 'light');
    const isLightTheme = theme === 'light';
    const [isReadmeModalOpen, setIsReadmeModalOpen] = useState(false);

    const readmeEvidence = useMemo(() => {
        if (!repoAnalysis || !Array.isArray(repoAnalysis.evidence)) return null;
        return repoAnalysis.evidence.find(item => item.type === 'readme');
    }, [repoAnalysis]);

    const tabs = useMemo(() => {
        if (profile?.source_type === 'repo') {
            return [
                { id: 'repo', label: 'Repo', icon: GitBranch, color: 'text-blue-400', accent: 'bg-blue-400' },
                { id: 'resources', label: 'Resources', icon: Youtube, color: 'text-red-400', accent: 'bg-red-400' },
                { id: 'practice', label: 'Practice', icon: BookOpen, color: 'text-emerald-400', accent: 'bg-emerald-400' },
            ];
        } else {
            return [
                { id: 'resources', label: 'Resources', icon: Youtube, color: 'text-red-400', accent: 'bg-red-400' },
                { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, color: 'text-amber-400', accent: 'bg-amber-400' },
                { id: 'practice', label: 'Practice', icon: BookOpen, color: 'text-emerald-400', accent: 'bg-emerald-400' },
            ];
        }
    }, [profile?.source_type]);

    // Per-node cache: { [nodeId]: { practice, resources } }
    const nodeCacheRef = useRef(null);
    if (nodeCacheRef.current === null) {
        try {
            const saved = sessionStorage.getItem('questmap_node_cache');
            const parsed = saved ? JSON.parse(saved) : {};
            nodeCacheRef.current = parsed.__version === NODE_CACHE_VERSION ? parsed : { __version: NODE_CACHE_VERSION };
        } catch {
            nodeCacheRef.current = { __version: NODE_CACHE_VERSION };
        }
    }
    const [loading, setLoading] = useState({ profile: false, map: false, recommendations: false, practice: false, resources: false });
    const [error, setError] = useState(null);
    const [initialLoadComplete, setInitialLoadComplete] = useState(false);
    const currentUserId = auth.currentUser ? auth.currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');
    const dashboardTitle = profile?.source_type === 'repo'
        ? (mapData?.topic || repoAnalysis?.repo?.fullName || profile?.repo_url || 'GitHub repo')
        : profile?.topic;

    // Load profile from sessionStorage on mount
    useEffect(() => {
        const stored = sessionStorage.getItem('questmap_profile');
        if (!stored) {
            navigate('/profile');
            return;
        }
        try {
            const parsed = JSON.parse(stored);
            setProfile(parsed);
        } catch {
            navigate('/profile');
        }
    }, [navigate]);

    // Fetch helper
    const apiFetch = useCallback(async (endpoint, body) => {
        const res = await fetch(`${API_BASE}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.details || err.error || `API error: ${res.status}`);
        }
        return res.json();
    }, []);

    // Initial data generation
    useEffect(() => {
        if (!profile || initialLoadComplete) return;

        const dashboardCached = sessionStorage.getItem('questmap_dashboard_cache');
        const resumeCached = sessionStorage.getItem('questmap_cached_data');
        const cached = dashboardCached || resumeCached;
        const isResumeCache = !dashboardCached && Boolean(resumeCached);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                const cachedTopic = parsed.topic || (parsed.profileData && parsed.profileData.topic);
                const cachedSourceKey = parsed.sourceKey || `topic:${String(cachedTopic || '').toLowerCase()}`;
                const currentSourceKey = getProfileSourceKey(profile);

                // If the user changed their topic in the profile, we MUST invalidate the old cache!
                if ((!isResumeCache && parsed.__version !== DASHBOARD_CACHE_VERSION) || cachedSourceKey !== currentSourceKey) {
                    sessionStorage.removeItem('questmap_dashboard_cache');
                    sessionStorage.removeItem('questmap_cached_data');
                    sessionStorage.removeItem('questmap_node_cache');
                } else {
                    setMapData(parsed.mapData);
                    setRecommendations(parsed.recommendations);
                    setProfileData(parsed.profileData);
                    setRepoAnalysis(parsed.repoAnalysis || null);
                    setInitialLoadComplete(true);
                    
                    // If it came from Resume Quest, move it to dashboard cache and clear the old one
                    if (sessionStorage.getItem('questmap_cached_data')) {
                        sessionStorage.setItem('questmap_dashboard_cache', cached);
                        sessionStorage.removeItem('questmap_cached_data'); 
                    }
                    return;
                }
            } catch (e) {
                console.error("Cache parse failed:", e);
            }
        }

        const generateInitialData = async () => {
            setError(null);

            try {
                // Step 1: Generate profile & learning history
                const currentUser = auth.currentUser;
                const uid = currentUser ? currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');

                if (profile.source_type === 'repo') {
                    setLoading(l => ({ ...l, profile: true, map: true, recommendations: true }));
                    const repoResult = await apiFetch('repo/analyze', {
                        userId: uid,
                        repoUrl: profile.repo_url || profile.topic,
                        skillLevel: profile.skill_level,
                    });
                    const repoProfileData = buildRepoProfileData(repoResult, profile.skill_level);
                    const repoMapData = buildRepoMapData(repoResult, profile.skill_level);
                    const repoRecommendations = buildRepoRecommendations(repoResult, profile.skill_level);

                    setRepoAnalysis(repoResult);
                    setProfileData(repoProfileData);
                    setMapData(repoMapData);
                    setRecommendations(repoRecommendations);
                    setLoading(l => ({ ...l, profile: false, map: false, recommendations: false }));
                    setInitialLoadComplete(true);

                    sessionStorage.setItem('questmap_dashboard_cache', JSON.stringify({
                        __version: DASHBOARD_CACHE_VERSION,
                        sourceKey: getProfileSourceKey(profile),
                        topic: repoMapData.topic,
                        mapData: repoMapData,
                        recommendations: repoRecommendations,
                        profileData: repoProfileData,
                        repoAnalysis: repoResult,
                    }));

                    if (import.meta.env.VITE_AUTOSAVE !== 'false') {
                        fetch(`${API_BASE}/save-quest`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                userId: uid,
                                topic: repoMapData.topic,
                                skillLevel: profile.skill_level,
                                profileData: repoProfileData,
                                mapData: repoMapData,
                                recommendations: repoRecommendations,
                            })
                        }).catch(e => console.error("Auto-save failed:", e));
                    }
                    return;
                }

                setLoading(l => ({ ...l, profile: true }));
                const profResult = await apiFetch('generate-profile', { ...profile, userId: uid });
                setProfileData(profResult);
                setLoading(l => ({ ...l, profile: false }));

                // Step 2 & 3: Generate map + recommendations IN PARALLEL (both depend on profile, not on each other)
                setLoading(l => ({ ...l, map: true, recommendations: true }));

                const [mapResult, recResult] = await Promise.all([
                    apiFetch('generate-map', {
                        ...profile,
                        userId: uid,
                        learning_history: profResult.learning_history,
                    }),
                    apiFetch('generate-recommendations', {
                        ...profile,
                        userId: uid,
                        learning_history: profResult.learning_history,
                        knowledge_gaps: profResult.knowledge_gaps,
                    }),
                ]);

                setMapData(mapResult);
                setLoading(l => ({ ...l, map: false }));

                setRecommendations(recResult.recommendations);
                setLoading(l => ({ ...l, recommendations: false }));

                setInitialLoadComplete(true);

                // Cache the main curriculum data so we don't re-fetch if we go to quiz and back
                sessionStorage.setItem('questmap_dashboard_cache', JSON.stringify({
                    __version: DASHBOARD_CACHE_VERSION,
                    sourceKey: getProfileSourceKey(profile),
                    topic: profile.topic,
                    mapData: mapResult,
                    recommendations: recResult.recommendations,
                    profileData: profResult
                }));

                // PERSISTENCE: Save quest to MongoDB
                if (import.meta.env.VITE_AUTOSAVE !== 'false') {
                    const currentUser = auth.currentUser;
                    const uid = currentUser ? currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');

                    fetch(`${API_BASE}/save-quest`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            userId: uid,
                            topic: profile.topic,
                            skillLevel: profile.skill_level,
                            profileData: profResult,
                            mapData: mapResult,
                            recommendations: recResult.recommendations
                        })
                    }).catch(e => console.error("Auto-save failed:", e));
                }

            } catch (err) {
                console.error('Generation error:', err);
                setError(err.message);
                setLoading({ profile: false, map: false, recommendations: false, practice: false, resources: false });
            }
        };

        generateInitialData();
    }, [profile, initialLoadComplete, apiFetch]);

    useEffect(() => {
        if (!profile?.topic || !initialLoadComplete || profile.source_type === 'repo') return undefined;

        let cancelled = false;
        const loadMastery = async () => {
            try {
                const res = await fetch(`${API_BASE}/mastery/summary/${currentUserId}?topic=${encodeURIComponent(profile.topic)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setMasteryOverview(data);
            } catch (err) {
                console.warn('Failed to load mastery overview:', err);
            }
        };

        loadMastery();
        return () => {
            cancelled = true;
        };
    }, [currentUserId, initialLoadComplete, profile?.topic, profile?.source_type]);

    // Polling hook for background repository ingestion
    useEffect(() => {
        if (!repoAnalysis) return;
        const status = repoAnalysis.code_ingestion?.status || repoAnalysis.codeIngestion?.status;
        if (status !== 'processing') return;

        let active = true;
        const analysisId = repoAnalysis.id || repoAnalysis._id;
        if (!analysisId) return;

        const interval = setInterval(async () => {
            try {
                const res = await fetch(`${API_BASE}/repo/analysis/${analysisId}`);
                if (!res.ok) return;
                const data = await res.json();

                if (!active) return;

                const newStatus = data.codeIngestion?.status || data.code_ingestion?.status;
                if (newStatus !== 'processing') {
                    clearInterval(interval);

                    const repoProfileData = buildRepoProfileData(data, profile.skill_level);
                    const repoMapData = buildRepoMapData(data, profile.skill_level);
                    const repoRecommendations = buildRepoRecommendations(data, profile.skill_level);

                    setRepoAnalysis(data);
                    setProfileData(repoProfileData);
                    setMapData(repoMapData);
                    setRecommendations(repoRecommendations);

                    setSelectedNode(prev => {
                        if (!prev) return null;
                        const previousConceptId = String(prev.id || '').split(':').pop();
                        const updatedNode = repoMapData.nodes.find(n => (
                            n.id === prev.id ||
                            String(n.id || '').split(':').pop() === previousConceptId ||
                            n.label === prev.label
                        ));
                        return updatedNode || prev;
                    });

                    // Update session storage cache
                    sessionStorage.setItem('questmap_dashboard_cache', JSON.stringify({
                        __version: DASHBOARD_CACHE_VERSION,
                        sourceKey: getProfileSourceKey(profile),
                        topic: repoMapData.topic,
                        mapData: repoMapData,
                        recommendations: repoRecommendations,
                        profileData: repoProfileData,
                        repoAnalysis: data,
                    }));
                }
            } catch (err) {
                console.error("Error polling repo analysis status:", err);
            }
        }, 3000);

        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [repoAnalysis, profile, API_BASE]);

    // Persist node cache to sessionStorage (survives quiz navigation)
    const persistNodeCache = useCallback((cache) => {
        try {
            sessionStorage.setItem('questmap_node_cache', JSON.stringify(cache));
        } catch (err) {
            console.warn('Failed to persist node cache:', err);
        }
    }, []);

    // Load node-specific data when a node is selected
    const handleNodeSelect = useCallback(async (node) => {
        setSelectedNode(node);
        setIsSidePanelVisible(true);
        const nodeId = node.id || node.label;

        // Check cache first — instant restore
        const cached = nodeCacheRef.current[nodeId];
        if (cached) {
            console.log(`[Cache HIT] Node "${node.label}" — restoring from cache`);
            setPracticeData(cached.practice);
            setResourceData(cached.resources);
            return;
        }

        console.log(`[Cache MISS] Node "${node.label}" — fetching node data`);

        // Clear old data and trigger loading state
        setPracticeData(null);
        setResourceData(null);
        setLoading(l => ({ ...l, practice: true, resources: true }));

        const currentUser = auth.currentUser;
        const uid = currentUser ? currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');

        try {
            const nodeTopic = node.topicOverride || node.topic || profile.topic;
            const nodeKeyConcepts = node.key_concepts || node.learning_goals || [];

            // SINGLE merged call — 1 Pinecone lookup + 2 parallel LLM calls on the backend
            const nodeData = await apiFetch('generate-node-data', {
                topic: nodeTopic,
                userId: uid,
                node_label: node.label,
                skill_level: profile.skill_level,
                key_concepts: nodeKeyConcepts,
                resource_query: node.resourceQuery || null,
                ytAccessToken: sessionStorage.getItem('yt_access_token') || null,
            });

            setPracticeData(nodeData.practice);
            setResourceData(nodeData.resources);

            // Store in cache
            nodeCacheRef.current[nodeId] = { practice: nodeData.practice, resources: nodeData.resources };
            persistNodeCache(nodeCacheRef.current);
        } catch (err) {
            console.error('Node data generation error:', err);
        } finally {
            setLoading(l => ({ ...l, practice: false, resources: false }));
        }
    }, [profile, apiFetch, persistNodeCache]);

    const handleRepoConceptSelect = useCallback((concept, targetTab = 'resources') => {
        const codeIngestion = repoAnalysis?.code_ingestion || repoAnalysis?.codeIngestion || null;
        const codeFiles = repoAnalysis?.code_files || repoAnalysis?.codeFiles || [];
        const repoNode = {
            id: `repo:${concept.repoFullName || 'repo'}:${concept.id}`,
            label: concept.title,
            topicOverride: concept.title,
            key_concepts: (concept.keywords || concept.tools || []).slice(0, 8),
            learning_goals: concept.learning_goals || [],
            prerequisites: concept.prerequisites || [],
            repoConcept: true,
            resourceQuery: concept.resource_query,
            search_query: concept.search_query || '',
            code_references: concept.code_references || [],
            code_ingestion: codeIngestion,
            code_files: codeFiles,
        };
        setActiveTab(targetTab);
        if (targetTab === 'repo') {
            setActiveRepoSubtab('code');
        }
        handleNodeSelect(repoNode);
    }, [handleNodeSelect, repoAnalysis]);

    const handleLogout = () => {
        sessionStorage.removeItem('questmap_profile');
        sessionStorage.removeItem('questmap_dashboard_cache');
        sessionStorage.removeItem('questmap_node_cache');
        navigate('/');
    };

    const handleNewTopic = () => {
        sessionStorage.removeItem('questmap_profile');
        sessionStorage.removeItem('questmap_dashboard_cache');
        sessionStorage.removeItem('questmap_node_cache');
        navigate('/profile');
    };

    const clampPanelWidth = useCallback((width) => {
        const viewportLimit = typeof window === 'undefined'
            ? MAX_PANEL_WIDTH
            : Math.max(MIN_PANEL_WIDTH, Math.min(window.innerWidth * 0.85, window.innerWidth - MIN_MAP_WIDTH));
        return Math.min(Math.max(width, MIN_PANEL_WIDTH), Math.min(MAX_PANEL_WIDTH, viewportLimit));
    }, []);

    const handlePanelResizeStart = useCallback((event) => {
        event.preventDefault();
        setIsResizingPanel(true);
    }, []);

    useEffect(() => {
        if (!isResizingPanel) return undefined;

        const handlePointerMove = (event) => {
            const nextWidth = clampPanelWidth(window.innerWidth - event.clientX);
            setPanelWidth(nextWidth);
        };
        const handlePointerUp = () => {
            setIsResizingPanel(false);
        };

        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);

        return () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, [clampPanelWidth, isResizingPanel]);

    useEffect(() => {
        sessionStorage.setItem('questmap_panel_width', String(panelWidth));
    }, [panelWidth]);

    useEffect(() => {
        sessionStorage.setItem('questmap_side_panel_visible', String(isSidePanelVisible));
    }, [isSidePanelVisible]);

    const hideSidePanel = useCallback(() => {
        setIsSidePanelVisible(false);
        setIsPanelMaximized(false);
    }, []);

    const showSidePanel = useCallback(() => {
        setIsSidePanelVisible(true);
    }, []);

    useEffect(() => {
        const handleResize = () => {
            setPanelWidth(current => clampPanelWidth(current));
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [clampPanelWidth]);

    const handleThemeToggle = useCallback(() => {
        setTheme(current => {
            const next = current === 'dark' ? 'light' : 'dark';
            sessionStorage.setItem('questmap_theme', next);
            return next;
        });
    }, []);

    // Initial loading state
    if (!profile) return null;

    if (!initialLoadComplete && (loading.profile || loading.map || loading.recommendations)) {
        const isRepoLoading = profile.source_type === 'repo';
        const msg = isRepoLoading
            ? 'Analyzing repository...'
            : loading.profile
            ? 'Analyzing learning DNA...'
            : loading.map
                ? 'Forging your 3D Knowledge Sphere...'
                : 'Mapping high-probability quest paths...';
        const sub = isRepoLoading
            ? 'Extracting evidence and mapping repo signals to teachable concepts'
            : loading.profile
            ? 'Synthesizing knowledge lattice based on your cognitive profile'
            : loading.map
                ? 'Distributing curriculum nodes on a Fibonacci neural manifold'
                : 'Prioritizing objectives to bridge systemic knowledge gaps';

        return (
            <div className="min-h-screen bg-[#15171e] text-white flex items-center justify-center">
                <TubesBackground className="w-full h-full flex items-center justify-center" enableClickInteraction={false}>
                    <div className="flex flex-col items-center justify-center h-full">
                        <LoadingState message={msg} subMessage={sub} />
                    </div>
                </TubesBackground>
            </div>
        );
    }

    if (error && !initialLoadComplete) {
        return (
            <div className="min-h-screen bg-[#15171e] text-white flex items-center justify-center p-6">
                <div className="max-w-md text-center">
                    <div className="text-red-400 text-5xl mb-4 font-outfit uppercase">System Failure</div>
                    <h2 className="text-xl font-black mb-2 uppercase tracking-tighter">Neural Lattice Collapse</h2>
                    <p className="text-white/40 text-xs mb-6 font-mono">{error}</p>
                    <div className="flex gap-3 justify-center">
                        <button onClick={() => { setError(null); setInitialLoadComplete(false); }} className="px-8 py-3 bg-blue-600 hover:bg-blue-500 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] transition-all flex items-center gap-2">
                            <RefreshCw className="w-4 h-4" /> Reset Mesh
                        </button>
                        <button onClick={handleNewTopic} className="px-8 py-3 bg-white/5 border border-white/10 hover:bg-white/10 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] transition-all">
                            New Input
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`h-[100dvh] md:h-screen flex flex-col overflow-hidden selection:bg-blue-500/30 font-sans ${isLightTheme ? 'quest-theme-light bg-[#f0f2f5] text-gray-950' : 'bg-[#15171e] text-white'}`}>
            {/* Top Bar - Glassmorphism */}
            {!isPanelMaximized && (
                <header className={`flex-shrink-0 border-b px-4 md:px-8 py-3 md:py-4 backdrop-blur-xl z-50 ${isLightTheme ? 'border-gray-200 bg-[#f8fafc]/80' : 'border-white/5 bg-[#11131a]/60'}`}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-6">
                            <div className="flex items-center gap-3">
                                <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-2 rounded-xl shadow-lg shadow-blue-500/20">
                                    <Compass className="w-5 h-5 text-white" />
                                </div>
                                <span className={cn("text-lg font-black tracking-tighter uppercase font-outfit", isLightTheme ? "text-gray-950" : "text-white")}>QuestMap.AI</span>
                            </div>
                            <div className={cn("h-6 w-px", isLightTheme ? "bg-gray-200" : "bg-white/10")} />
                            <div className="flex items-center gap-2">
                                <div className={cn("flex items-center gap-3 px-4 py-1.5 rounded-full border", isLightTheme ? "bg-gray-100 border-gray-200" : "bg-white/5 border-white/10")}>
                                    <Brain className="w-4 h-4 text-purple-400" />
                                    <span className={cn("text-[11px] font-black uppercase tracking-widest max-w-[200px] truncate", isLightTheme ? "text-gray-700" : "text-gray-300")}>{dashboardTitle}</span>
                                </div>

                            </div>
                            {profile.source_type !== 'repo' && (
                                <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.2em] border ${profile.skill_level === 'beginner' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                                    profile.skill_level === 'intermediate' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                                        'bg-red-500/10 text-red-400 border-red-500/20'
                                    }`}>
                                    Tier: {profile.skill_level}
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-6">
                            {profileData && (
                                <div className="hidden lg:flex items-center gap-6 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                    <span className="flex items-center gap-2">
                                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                                        {profileData.recommended_pace} PACE
                                    </span>
                                </div>
                            )}
                            <button
                                type="button"
                                onClick={handleThemeToggle}
                                className={cn(
                                    "h-9 w-[76px] rounded-full border p-1 transition-colors flex items-center",
                                    isLightTheme ? "bg-gray-100 border-gray-300 justify-end" : "bg-white/5 border-white/10 justify-start"
                                )}
                                aria-label="Toggle light or dark theme"
                                aria-pressed={isLightTheme}
                            >
                                <span className={cn(
                                    "h-7 w-7 rounded-full flex items-center justify-center shadow-sm transition-colors",
                                    isLightTheme ? "bg-white text-amber-500" : "bg-gray-800 text-blue-300"
                                )}>
                                    {isLightTheme ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
                                </span>
                            </button>

                            <button onClick={handleNewTopic} className={cn("px-4 py-2 rounded-xl border text-[10px] font-black uppercase tracking-widest transition-all", isLightTheme ? "bg-gray-100 border-gray-200 hover:bg-gray-200 text-gray-600 hover:text-gray-950" : "bg-white/5 border-white/10 hover:bg-white/10 text-white/60 hover:text-white")}>
                                Change Mesh
                            </button>
                            <button onClick={handleLogout} className={cn("p-2 transition-colors", isLightTheme ? "text-gray-400 hover:text-gray-700" : "text-white/20 hover:text-white/60")}>
                                <LogOut className="w-5 h-5" />
                            </button>
                        </div>
                    </div>
                </header>
            )}

            {/* Main Content */}
            <div className={cn(
                "flex-1 min-h-0 overflow-hidden relative",
                !isSidePanelVisible && "flex",
                isSidePanelVisible && isPanelMaximized && "flex flex-col",
                isSidePanelVisible && !isPanelMaximized && "md:flex max-md:grid max-md:grid-rows-[minmax(0,1fr)_minmax(220px,45%)]"
            )}>

                {/* Background Decoration */}
                    <div className={cn("absolute inset-0 pointer-events-none", isLightTheme ? "opacity-0" : "opacity-20")}>
                    <div className="absolute top-1/4 -left-20 w-80 h-80 bg-blue-500/10 rounded-full blur-[100px]" />
                    <div className="absolute bottom-1/4 -right-20 w-80 h-80 bg-purple-500/10 rounded-full blur-[100px]" />
                </div>

                {/* Left: Learning Path Map */}
                <div className={cn(
                    "flex flex-col min-w-0 min-h-0 relative z-10",
                    isPanelMaximized && isSidePanelVisible ? "hidden" : "flex-1"
                )}>
                    {/* Repo Summary Section */}
                    {profile.source_type === 'repo' && mapData && (
                        <div className="px-4 md:px-8 pt-3 md:pt-6 pb-2 flex-shrink-0">
                            <RepoOverview mapData={mapData} />
                        </div>
                    )}

                    {/* Map */}
                    <div className="flex-1 min-h-0 overflow-hidden relative">
                        <LearningPathMap
                            mapData={mapData}
                            selectedNode={selectedNode}
                            onNodeSelect={handleNodeSelect}
                        />

                        {!isSidePanelVisible && (
                            <button
                                type="button"
                                onClick={showSidePanel}
                                title="Show learning panel"
                                aria-label="Show learning panel"
                                className={cn(
                                    "absolute right-3 top-3 z-40 flex items-center gap-2 rounded-2xl border px-3 py-3 shadow-lg backdrop-blur-md transition-all hover:scale-105",
                                    isLightTheme
                                        ? "bg-white/95 border-gray-200 text-gray-700 hover:text-gray-950"
                                        : "bg-[#11131a]/95 border-white/10 text-gray-300 hover:text-white"
                                )}
                            >
                                <PanelRightOpen className="w-4 h-4" />
                                <span className="hidden sm:inline text-[10px] font-black uppercase tracking-widest">Panel</span>
                            </button>
                        )}
                    </div>

                    {/* Selected Node Status Bar removed per user request */}
                </div>

                {isSidePanelVisible && !isPanelMaximized && (
                    <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-valuemin={MIN_PANEL_WIDTH}
                        aria-valuemax={MAX_PANEL_WIDTH}
                        aria-valuenow={Math.round(panelWidth)}
                        onPointerDown={handlePanelResizeStart}
                        className={cn(
                            "hidden md:flex w-2 flex-shrink-0 items-center justify-center cursor-col-resize relative z-30 group",
                            isLightTheme ? "bg-transparent" : "bg-transparent"
                        )}
                    >
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                hideSidePanel();
                            }}
                            onPointerDown={(event) => event.stopPropagation()}
                            title="Hide learning panel"
                            aria-label="Hide learning panel"
                            className={cn(
                                "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 rounded-full border p-1.5 opacity-0 group-hover:opacity-100 transition-opacity shadow-md",
                                isLightTheme
                                    ? "bg-white border-gray-200 text-gray-500 hover:text-gray-900"
                                    : "bg-[#11131a] border-white/10 text-gray-400 hover:text-white"
                            )}
                        >
                            <PanelRightClose className="w-3.5 h-3.5" />
                        </button>
                        <div className={cn(
                            "h-14 w-1 rounded-full transition-colors",
                            isResizingPanel
                                ? "bg-blue-400"
                                : isLightTheme
                                    ? "bg-gray-300 group-hover:bg-blue-400"
                                    : "bg-white/10 group-hover:bg-blue-400"
                        )} />
                    </div>
                )}

                {/* Right: Data Expansion Panels */}
                {isSidePanelVisible && (
                <div
                    className={cn(
                        "flex flex-col min-h-0 min-w-0 backdrop-blur-3xl border-l relative z-30",
                        isPanelMaximized
                            ? "w-full flex-1 min-h-0 border-l-0"
                            : "flex-shrink-0 max-md:!w-full max-md:border-l-0 max-md:border-t",
                        isLightTheme ? "bg-[#f8fafc]/90 border-gray-200 max-md:border-gray-200" : "bg-[#11131a]/85 border-white/5 max-md:border-white/5"
                    )}
                    style={isPanelMaximized ? undefined : { width: panelWidth }}
                >
                    {/* Mobile minimize bar when panel is maximized */}
                    {isPanelMaximized && (
                        <div className={cn(
                            "flex-shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b md:hidden",
                            isLightTheme ? "border-gray-200" : "border-white/5"
                        )}>
                            <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                                {tabs.find(t => t.id === activeTab)?.label || 'Panel'}
                            </span>
                            <button
                                type="button"
                                onClick={() => setIsPanelMaximized(false)}
                                title="Minimize panel"
                                aria-label="Minimize panel"
                                className={cn(
                                    "rounded-xl border p-2 transition-colors",
                                    isLightTheme
                                        ? "border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-white"
                                        : "border-white/10 text-gray-400 hover:text-white hover:bg-white/10"
                                )}
                            >
                                <Minimize2 className="w-4 h-4" />
                            </button>
                        </div>
                    )}
                    {/* Tab Selection */}
                    {!isPanelMaximized && (
                        <div className={cn("flex-shrink-0 flex items-center gap-2 p-2 m-2 md:m-4 rounded-[1.5rem] border", isLightTheme ? "bg-gray-100 border-gray-200" : "bg-white/5 border-white/10")}>
                            <div className="flex flex-1 min-w-0">
                            {tabs.map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`flex-1 flex items-center justify-center gap-2 md:gap-3 py-3 md:py-4 rounded-2xl text-[9px] md:text-[10px] font-black uppercase tracking-widest transition-all relative min-w-0 ${activeTab === tab.id ? (isLightTheme ? 'text-gray-950 shadow-sm' : 'text-white shadow-xl') : 'text-gray-500 hover:text-gray-400'}`}
                                  >
                                    <tab.icon className={cn("w-4 h-4 flex-shrink-0", activeTab === tab.id ? tab.color : "text-gray-600")} />
                                    <span className="truncate">{tab.label}</span>
                                    {activeTab === tab.id && (
                                        <motion.div
                                            layoutId="tab-pill"
                                            className={cn("absolute inset-0 rounded-2xl -z-10", isLightTheme ? "bg-white" : "bg-white/10")}
                                            transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
                                        />
                                    )}
                                </button>
                            ))}
                            </div>
                            <button
                                type="button"
                                onClick={hideSidePanel}
                                title="Hide learning panel"
                                aria-label="Hide learning panel"
                                className={cn(
                                    "flex-shrink-0 rounded-xl border p-2.5 transition-colors",
                                    isLightTheme
                                        ? "border-gray-200 text-gray-500 hover:text-gray-900 hover:bg-white"
                                        : "border-white/10 text-gray-400 hover:text-white hover:bg-white/10"
                                )}
                            >
                                <PanelRightClose className="w-4 h-4" />
                            </button>
                        </div>
                    )}



                    {/* Scrollable Content Area */}
                    <div className={cn(
                        "flex-1 min-h-0 overflow-y-auto overscroll-y-contain touch-pan-y px-4 md:px-8 pb-4 md:pb-8 custom-scrollbar mobile-scroll-y",
                        isPanelMaximized && "pt-6"
                    )}>
                        <AnimatePresence mode="wait">
                            {activeTab === 'recommendations' && (
                                <motion.div key="rec" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                                    {loading.recommendations ? (
                                        <div className="py-20 flex flex-col items-center">
                                            <div className="w-10 h-10 border-4 border-white/5 border-t-blue-500 rounded-full animate-spin mb-4" />
                                            <span className="text-[10px] font-black uppercase tracking-widest animate-pulse text-gray-500">Scanning neural gaps...</span>
                                        </div>
                                    ) : (
                                        <>
                                            <MasteryOverview summary={masteryOverview} />
                                            <RecommendationList recommendations={recommendations} />
                                        </>
                                    )}
                                </motion.div>
                            )}
                            {activeTab === 'practice' && (
                                <motion.div key="prac" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                                    <PracticePanel
                                        practiceData={practiceData}
                                        loading={loading.practice}
                                        selectedNode={selectedNode}
                                        masteryContext={{ userId: currentUserId, topic: selectedNode?.topicOverride || selectedNode?.topic || profile.topic, skillLevel: profile.skill_level }}
                                    />
                                </motion.div>
                            )}
                            {activeTab === 'repo' && (
                                <motion.div key="repo" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} className="space-y-6">
                                    <div className={`sticky top-0 z-30 -mx-8 px-8 pt-2 pb-4 border-b space-y-4 backdrop-blur-md ${
                                        isLightTheme 
                                            ? 'bg-[#f8fafc]/95 border-gray-200' 
                                            : 'bg-[#11131a]/95 border-white/5'
                                    }`}>
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-2">
                                                <GitBranch className="w-4 h-4 text-blue-500 animate-pulse" />
                                                <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                                                    Repository Learning
                                                </span>
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => setIsPanelMaximized(!isPanelMaximized)}
                                                title={isPanelMaximized ? "Minimize panel" : "Maximize panel"}
                                                className="rounded-lg border border-gray-700/50 p-1.5 text-gray-400 transition hover:border-gray-600 hover:text-gray-200 flex items-center justify-center"
                                            >
                                                {isPanelMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                                            </button>
                                        </div>

                                        <div className="grid grid-cols-2 gap-2 rounded-2xl border border-gray-700/40 bg-gray-900/40 p-1.5 resource-subtabs">
                                            <button
                                                type="button"
                                                onClick={() => setActiveRepoSubtab('code')}
                                                className={`h-10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${
                                                    activeRepoSubtab === 'code'
                                                        ? 'bg-white/10 text-white shadow-sm'
                                                        : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                                                }`}
                                            >
                                                <Code className="w-3.5 h-3.5" />
                                                <span>Code</span>
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setActiveRepoSubtab('path')}
                                                className={`h-10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 ${
                                                    activeRepoSubtab === 'path'
                                                        ? 'bg-white/10 text-white shadow-sm'
                                                        : 'text-gray-500 hover:text-gray-300 hover:bg-white/5'
                                                }`}
                                            >
                                                <GitBranch className="w-3.5 h-3.5" />
                                                <span>Learning Path</span>
                                            </button>
                                        </div>
                                    </div>
                                    {activeRepoSubtab === 'code' ? (
                                        <CodeEvidencePanel
                                            key={selectedNode?.id || selectedNode?.label}
                                            selectedNode={selectedNode}
                                            userId={currentUserId}
                                            isLightTheme={isLightTheme}
                                            isMaximized={isPanelMaximized}
                                            onToggleMaximize={(val) => setIsPanelMaximized(typeof val === 'boolean' ? val : !isPanelMaximized)}
                                            showInnerMaximizer={false}
                                        />
                                    ) : (
                                        <RepoLearningPanel
                                            userId={currentUserId}
                                            skillLevel={profile.skill_level}
                                            initialAnalysis={repoAnalysis}
                                            onConceptSelect={(concept) => handleRepoConceptSelect(concept, 'repo')}
                                        />
                                    )}
                                </motion.div>
                            )}
                            {activeTab === 'resources' && (
                                <motion.div key="res" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                                    <ResourcePanel 
                                        resourceData={resourceData} 
                                        loading={loading.resources} 
                                        selectedNode={selectedNode} 
                                        userId={currentUserId} 
                                        isLightTheme={isLightTheme}
                                        isMaximized={isPanelMaximized}
                                        onToggleMaximize={(val) => setIsPanelMaximized(typeof val === 'boolean' ? val : !isPanelMaximized)}
                                    />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
                )}
            </div>

            {/* Readme Modal */}
            <ReadmeModal
                isOpen={isReadmeModalOpen}
                onClose={() => setIsReadmeModalOpen(false)}
                readmeContent={readmeEvidence?.detail}
                isLightTheme={isLightTheme}
            />
        </div>
    );
};

export default Dashboard;
