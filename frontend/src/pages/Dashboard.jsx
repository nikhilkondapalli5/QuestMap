import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Compass, Lightbulb, BookOpen, Youtube, LogOut, Clock, Brain, Sparkles, RefreshCw, Moon, Sun } from 'lucide-react';
import RecommendationList from '../components/RecommendationCard';
import PracticePanel from '../components/PracticePanel';
import ResourcePanel from '../components/ResourcePanel';
import LoadingState from '../components/LoadingState';
import TubesBackground from '../components/TubesBackground';
import LearningPathMap from '../components/LearningPathMap';
import { cn } from '../lib/utils';
import { auth } from '../firebase';
import { API_BASE } from '../config/api';

const TABS = [
    { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, color: 'text-amber-400', accent: 'bg-amber-400' },
    { id: 'practice', label: 'Practice', icon: BookOpen, color: 'text-emerald-400', accent: 'bg-emerald-400' },
    { id: 'resources', label: 'Resources', icon: Youtube, color: 'text-red-400', accent: 'bg-red-400' },
];

const NODE_CACHE_VERSION = 'youtube-search-v6';
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 760;

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

    // UI states
    const [selectedNode, setSelectedNode] = useState(null);
    const [activeTab, setActiveTab] = useState('recommendations');
    const [panelWidth, setPanelWidth] = useState(() => {
        const saved = Number(sessionStorage.getItem('questmap_panel_width'));
        return Number.isFinite(saved) && saved >= MIN_PANEL_WIDTH ? saved : DEFAULT_PANEL_WIDTH;
    });
    const [isResizingPanel, setIsResizingPanel] = useState(false);
    const [theme, setTheme] = useState(() => sessionStorage.getItem('questmap_theme') || 'dark');
    const isLightTheme = theme === 'light';

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
            throw new Error(err.error || `API error: ${res.status}`);
        }
        return res.json();
    }, []);

    // Initial data generation
    useEffect(() => {
        if (!profile || initialLoadComplete) return;

        const cached = sessionStorage.getItem('questmap_dashboard_cache') || sessionStorage.getItem('questmap_cached_data');
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                const cachedTopic = parsed.topic || (parsed.profileData && parsed.profileData.topic);

                // If the user changed their topic in the profile, we MUST invalidate the old cache!
                if (cachedTopic && profile.topic && cachedTopic.toLowerCase() !== profile.topic.toLowerCase()) {
                    sessionStorage.removeItem('questmap_dashboard_cache');
                    sessionStorage.removeItem('questmap_cached_data');
                    sessionStorage.removeItem('questmap_node_cache');
                } else {
                    setMapData(parsed.mapData);
                    setRecommendations(parsed.recommendations);
                    setProfileData(parsed.profileData);
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
            // SINGLE merged call — 1 Pinecone lookup + 2 parallel LLM calls on the backend
            const nodeData = await apiFetch('generate-node-data', {
                topic: profile.topic,
                userId: uid,
                node_label: node.label,
                skill_level: profile.skill_level,
                key_concepts: node.key_concepts,
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
        const viewportLimit = typeof window === 'undefined' ? MAX_PANEL_WIDTH : Math.max(MIN_PANEL_WIDTH, window.innerWidth - 420);
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
        const msg = loading.profile
            ? 'Analyzing learning DNA...'
            : loading.map
                ? 'Forging your 3D Knowledge Sphere...'
                : 'Mapping high-probability quest paths...';
        const sub = loading.profile
            ? 'Synthesizing knowledge lattice based on your cognitive profile'
            : loading.map
                ? 'Distributing curriculum nodes on a Fibonacci neural manifold'
                : 'Prioritizing objectives to bridge systemic knowledge gaps';

        return (
            <div className="min-h-screen bg-black text-white flex items-center justify-center">
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
            <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
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
        <div className={`h-screen flex flex-col overflow-hidden selection:bg-blue-500/30 font-sans ${isLightTheme ? 'quest-theme-light bg-slate-100 text-gray-950' : 'bg-[#000000] text-white'}`}>
            {/* Top Bar - Glassmorphism */}
            <header className={`flex-shrink-0 border-b px-8 py-4 backdrop-blur-xl z-50 ${isLightTheme ? 'border-gray-200 bg-white/80' : 'border-white/5 bg-black/40'}`}>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-6">
                        <div className="flex items-center gap-3">
                            <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-2 rounded-xl shadow-lg shadow-blue-500/20">
                                <Compass className="w-5 h-5 text-white" />
                            </div>
                            <span className={cn("text-lg font-black tracking-tighter uppercase font-outfit", isLightTheme ? "text-gray-950" : "text-white")}>QuestMap.AI</span>
                        </div>
                        <div className={cn("h-6 w-px", isLightTheme ? "bg-gray-200" : "bg-white/10")} />
                        <div className={cn("flex items-center gap-3 px-4 py-1.5 rounded-full border", isLightTheme ? "bg-gray-100 border-gray-200" : "bg-white/5 border-white/10")}>
                            <Brain className="w-4 h-4 text-purple-400" />
                            <span className={cn("text-[11px] font-black uppercase tracking-widest max-w-[200px] truncate", isLightTheme ? "text-gray-700" : "text-gray-300")}>{profile.topic}</span>
                        </div>
                        <span className={`px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-[0.2em] border ${profile.skill_level === 'beginner' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                            profile.skill_level === 'intermediate' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                                'bg-red-500/10 text-red-400 border-red-500/20'
                            }`}>
                            Tier: {profile.skill_level}
                        </span>
                    </div>
                    <div className="flex items-center gap-6">
                        {profileData && (
                            <div className="hidden lg:flex items-center gap-6 text-[10px] font-black uppercase tracking-widest text-gray-500">
                                <span className="flex items-center gap-2">
                                    <Clock className="w-3.5 h-3.5 text-blue-400" />
                                    {profileData.estimated_total_hours || mapData?.total_estimated_hours || '?'}H TOTAL
                                </span>
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
                        <button onClick={() => navigate('/quiz')} className="px-4 py-2 rounded-xl bg-blue-500/20 border border-blue-500/30 hover:bg-blue-500/40 text-[10px] font-black uppercase tracking-widest text-blue-300 hover:text-white transition-all">
                            Test Mastery
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

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden relative">

                {/* Background Decoration */}
                    <div className={cn("absolute inset-0 pointer-events-none", isLightTheme ? "opacity-0" : "opacity-20")}>
                    <div className="absolute top-1/4 -left-20 w-80 h-80 bg-blue-500/10 rounded-full blur-[100px]" />
                    <div className="absolute bottom-1/4 -right-20 w-80 h-80 bg-purple-500/10 rounded-full blur-[100px]" />
                </div>

                {/* Left: Learning Path Map */}
                <div className="flex-1 flex flex-col min-w-0 relative z-10">
                    {/* Map */}
                    <div className="flex-1 overflow-hidden">
                        <LearningPathMap
                            mapData={mapData}
                            selectedNode={selectedNode}
                            onNodeSelect={handleNodeSelect}
                        />
                    </div>

                    {/* Selected Node Status Bar removed per user request */}
                </div>

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
                    <div className={cn(
                        "h-14 w-1 rounded-full transition-colors",
                        isResizingPanel
                            ? "bg-blue-400"
                            : isLightTheme
                                ? "bg-gray-300 group-hover:bg-blue-400"
                                : "bg-white/10 group-hover:bg-blue-400"
                    )} />
                </div>

                {/* Right: Data Expansion Panels */}
                <div
                    className={cn(
                        "flex-shrink-0 flex flex-col backdrop-blur-3xl border-l relative z-20 max-md:w-full",
                        isLightTheme ? "bg-white/90 border-gray-200" : "bg-black/80 border-white/5"
                    )}
                    style={{ width: panelWidth }}
                >
                    {/* Tab Selection */}
                    <div className={cn("flex p-2 m-4 rounded-[1.5rem] border", isLightTheme ? "bg-gray-100 border-gray-200" : "bg-white/5 border-white/10")}>
                        {TABS.map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 flex items-center justify-center gap-3 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all relative ${activeTab === tab.id ? (isLightTheme ? 'text-gray-950 shadow-sm' : 'text-white shadow-xl') : 'text-gray-500 hover:text-gray-400'
                                    }`}
                            >
                                <tab.icon className={cn("w-4 h-4", activeTab === tab.id ? tab.color : "text-gray-600")} />
                                {tab.label}
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

                    {/* Panel Title Overlay */}
                    <div className="px-8 pb-4">
                        <div className="flex items-center gap-3 opacity-30">
                            {(() => {
                                const active = TABS.find(t => t.id === activeTab) || TABS[0];
                                return (
                                    <>
                                        <div className={cn("w-2 h-2 rounded-full", active.accent)} />
                                        <span className={cn("text-[10px] font-black uppercase tracking-[0.5em]", isLightTheme ? "text-gray-600" : "")}>{active.label} Stream</span>
                                    </>
                                );
                            })()}
                        </div>
                    </div>

                    {/* Scrollable Content Area */}
                    <div className="flex-1 overflow-y-auto px-8 pb-8 custom-scrollbar">
                        <AnimatePresence mode="wait">
                            {activeTab === 'recommendations' && (
                                <motion.div key="rec" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                                    {loading.recommendations ? (
                                        <div className="py-20 flex flex-col items-center">
                                            <div className="w-10 h-10 border-4 border-white/5 border-t-blue-500 rounded-full animate-spin mb-4" />
                                            <span className="text-[10px] font-black uppercase tracking-widest animate-pulse text-gray-500">Scanning neural gaps...</span>
                                        </div>
                                    ) : (
                                        <RecommendationList recommendations={recommendations} />
                                    )}
                                </motion.div>
                            )}
                            {activeTab === 'practice' && (
                                <motion.div key="prac" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                                    <PracticePanel practiceData={practiceData} loading={loading.practice} selectedNode={selectedNode} />
                                </motion.div>
                            )}
                            {activeTab === 'resources' && (
                                <motion.div key="res" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                                    <ResourcePanel resourceData={resourceData} loading={loading.resources} selectedNode={selectedNode} />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default Dashboard;
