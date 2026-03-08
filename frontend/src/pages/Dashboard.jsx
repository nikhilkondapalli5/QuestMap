import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Compass, Map, Lightbulb, BookOpen, Youtube, LogOut, User, Clock, Brain, ChevronRight, Sparkles, RefreshCw, Download, X } from 'lucide-react';
import RecommendationList from '../components/RecommendationCard';
import PracticePanel from '../components/PracticePanel';
import ResourcePanel from '../components/ResourcePanel';
import LoadingState from '../components/LoadingState';
import TubesBackground from '../components/TubesBackground';
import LearningPathMap from '../components/LearningPathMap';
import { cn } from '../lib/utils';
import { auth } from '../firebase';
// Assuming cn utility is available here

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5001';

const TABS = [
    { id: 'recommendations', label: 'Recommendations', icon: Lightbulb, color: 'text-amber-400', accent: 'bg-amber-400' },
    { id: 'practice', label: 'Practice', icon: BookOpen, color: 'text-emerald-400', accent: 'bg-emerald-400' },
    { id: 'resources', label: 'Resources', icon: Youtube, color: 'text-red-400', accent: 'bg-red-400' },
];

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
    const [recDebugContext, setRecDebugContext] = useState(null);

    // UI states
    const [selectedNode, setSelectedNode] = useState(null);
    const [activeTab, setActiveTab] = useState('recommendations');
    const [loading, setLoading] = useState({ profile: false, map: false, recommendations: false, practice: false, resources: false });
    const [error, setError] = useState(null);
    const [initialLoadComplete, setInitialLoadComplete] = useState(false);
    const [documents, setDocuments] = useState([]);

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
        const res = await fetch(`${API_BASE}/api/${endpoint}`, {
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

        // Check for cached data (from Resume Quest)
        const cached = sessionStorage.getItem('questmap_cached_data');
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                setMapData(parsed.mapData);
                setRecommendations(parsed.recommendations);
                setProfileData(parsed.profileData);
                setInitialLoadComplete(true);
                sessionStorage.removeItem('questmap_cached_data'); // Clear it after use
                return;
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

                // Step 2: Generate knowledge map
                setLoading(l => ({ ...l, map: true }));
                const mapResult = await apiFetch('generate-map', {
                    ...profile,
                    userId: uid,
                    learning_history: profResult.learning_history,
                });
                setMapData(mapResult);
                setLoading(l => ({ ...l, map: false }));

                // Step 3: Generate recommendations
                setLoading(l => ({ ...l, recommendations: true }));
                const recResult = await apiFetch('generate-recommendations', {
                    ...profile,
                    userId: uid,
                    learning_history: profResult.learning_history,
                    knowledge_gaps: profResult.knowledge_gaps,
                });
                setRecommendations(recResult.recommendations);
                setRecDebugContext(recResult._debug_context);
                setLoading(l => ({ ...l, recommendations: false }));

                setInitialLoadComplete(true);

                // PERSISTENCE: Save quest to MongoDB
                if (import.meta.env.VITE_AUTOSAVE !== 'false') {
                    const currentUser = auth.currentUser;
                    const uid = currentUser ? currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');

                    fetch(`${API_BASE}/api/save-quest`, {
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

    // Load node-specific data when a node is selected
    const handleNodeSelect = useCallback(async (node) => {
        setSelectedNode(node);

        // Immediate UI feedback: Clear old data and trigger loading state
        setPracticeData(null);
        setResourceData(null);
        setLoading(l => ({ ...l, practice: true, resources: true }));

        const currentUser = auth.currentUser;
        const uid = currentUser ? currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');

        try {
            // FIRE IN PARALLEL to reduce lag
            const [practiceResult, resourceResult] = await Promise.all([
                apiFetch('generate-practice', {
                    topic: profile.topic,
                    userId: uid,
                    node_label: node.label,
                    skill_level: profile.skill_level,
                    key_concepts: node.key_concepts,
                }),
                apiFetch('generate-resources', {
                    topic: profile.topic,
                    userId: uid,
                    node_label: node.label,
                    skill_level: profile.skill_level,
                })
            ]);

            setPracticeData(practiceResult);
            setResourceData(resourceResult);
        } catch (err) {
            console.error('Node data generation error:', err);
        } finally {
            setLoading(l => ({ ...l, practice: false, resources: false }));
        }
    }, [profile, apiFetch]);

    const handleLogout = () => {
        sessionStorage.removeItem('questmap_profile');
        navigate('/');
    };

    const handleNewTopic = () => {
        sessionStorage.removeItem('questmap_profile');
        navigate('/profile');
    };

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
        <div className="h-screen bg-[#000000] text-white flex flex-col overflow-hidden selection:bg-blue-500/30 font-sans">
            {/* Top Bar - Glassmorphism */}
            <header className="flex-shrink-0 border-b border-white/5 px-8 py-4 bg-black/40 backdrop-blur-xl z-50">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-6">
                        <div className="flex items-center gap-3">
                            <div className="bg-gradient-to-br from-blue-500 to-indigo-600 p-2 rounded-xl shadow-lg shadow-blue-500/20">
                                <Compass className="w-5 h-5 text-white" />
                            </div>
                            <span className="text-lg font-black tracking-tighter uppercase font-outfit text-white">QuestMap.AI</span>
                        </div>
                        <div className="h-6 w-px bg-white/10" />
                        <div className="flex items-center gap-3 px-4 py-1.5 rounded-full bg-white/5 border border-white/10">
                            <Brain className="w-4 h-4 text-purple-400" />
                            <span className="text-[11px] font-black uppercase tracking-widest text-gray-300 max-w-[200px] truncate">{profile.topic}</span>
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
                        <button onClick={() => navigate('/quiz')} className="px-4 py-2 rounded-xl bg-blue-500/20 border border-blue-500/30 hover:bg-blue-500/40 text-[10px] font-black uppercase tracking-widest text-blue-300 hover:text-white transition-all">
                            Test Mastery
                        </button>
                        <button onClick={handleNewTopic} className="px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-[10px] font-black uppercase tracking-widest text-white/60 hover:text-white transition-all">
                            Change Mesh
                        </button>
                        <button onClick={handleLogout} className="p-2 text-white/20 hover:text-white/60 transition-colors">
                            <LogOut className="w-5 h-5" />
                        </button>
                    </div>
                </div>
            </header>

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden relative">

                {/* Background Decoration */}
                <div className="absolute inset-0 pointer-events-none opacity-20">
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

                    {/* Selected Node Status Bar - Glass */}
                    <AnimatePresence>
                        {selectedNode && (
                            <motion.div
                                initial={{ y: 100, opacity: 0 }}
                                animate={{ y: 0, opacity: 1 }}
                                exit={{ y: 100, opacity: 0 }}
                                className="absolute bottom-8 left-8 right-8 z-30"
                            >
                                <div className="bg-black/60 backdrop-blur-2xl border border-white/10 rounded-[2.5rem] p-8 shadow-2xl flex items-center justify-between gap-12 group relative">
                                    <button
                                        onClick={() => setSelectedNode(null)}
                                        className="absolute -top-3 -right-3 w-8 h-8 bg-gray-800 text-gray-400 hover:text-white rounded-full flex items-center justify-center border border-white/10 shadow-xl transition-colors z-40"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-4 mb-2">
                                            <span className="px-3 py-1 bg-blue-500/10 border border-blue-500/20 rounded-full text-[9px] font-black uppercase tracking-widest text-blue-400">
                                                {selectedNode.bloom_level}
                                            </span>
                                            <h3 className="text-xl font-black font-outfit text-white uppercase tracking-tight truncate">{selectedNode.label}</h3>
                                        </div>
                                        <p className="text-sm text-gray-400 leading-relaxed max-w-2xl line-clamp-2">{selectedNode.description}</p>
                                    </div>

                                    <div className="flex items-center gap-10 flex-shrink-0">
                                        <div className="flex flex-col items-end">
                                            <span className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1">Time Investment</span>
                                            <span className="text-lg font-black text-white">{selectedNode.estimated_hours}H EST</span>
                                        </div>
                                        <div className="h-10 w-px bg-white/10" />
                                        <div className="flex flex-col items-end">
                                            <span className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1">Node Status</span>
                                            <span className={cn(
                                                "text-sm font-black uppercase tracking-widest",
                                                selectedNode.status === 'completed' ? 'text-emerald-400' :
                                                    selectedNode.status === 'recommended_next' ? 'text-purple-400' :
                                                        selectedNode.status === 'in_progress' ? 'text-blue-400' :
                                                            'text-gray-500'
                                            )}>
                                                {(selectedNode.status || '').replace('_', ' ')}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Right: Data Expansion Panels - Dark Side Panel */}
                <div className="w-[480px] flex-shrink-0 flex flex-col bg-black/80 backdrop-blur-3xl border-l border-white/5 relative z-20">
                    {/* Tab Selection */}
                    <div className="flex p-2 bg-white/5 m-4 rounded-[1.5rem] border border-white/10">
                        {TABS.map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`flex-1 flex items-center justify-center gap-3 py-4 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all relative ${activeTab === tab.id ? 'text-white shadow-xl' : 'text-gray-500 hover:text-gray-400'
                                    }`}
                            >
                                <tab.icon className={cn("w-4 h-4", activeTab === tab.id ? tab.color : "text-gray-600")} />
                                {tab.label}
                                {activeTab === tab.id && (
                                    <motion.div
                                        layoutId="tab-pill"
                                        className="absolute inset-0 bg-white/10 rounded-2xl -z-10"
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
                                        <span className="text-[10px] font-black uppercase tracking-[0.5em]">{active.label} Stream</span>
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
