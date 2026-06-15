import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Compass, User, BookOpen, Target, Sparkles, ArrowRight, LogOut, History, Globe, GitBranch } from 'lucide-react';
import { auth } from '../firebase';
import { signOut } from 'firebase/auth';
import LoadingState from '../components/LoadingState';
import TubesBackground from '../components/TubesBackground';
import QuestLog from '../components/QuestLog';
import DocumentUpload from '../components/DocumentUpload';
import DomainPreferences from '../components/DomainPreferences';
import { API_BASE } from '../config/api';

const SKILL_LEVELS = [
    { value: 'beginner', label: 'Beginner', desc: 'Just starting out', color: 'from-green-500 to-emerald-600', icon: '🌱' },
    { value: 'intermediate', label: 'Intermediate', desc: 'Have some experience', color: 'from-yellow-500 to-amber-600', icon: '📈' },
    { value: 'advanced', label: 'Advanced', desc: 'Looking to master', color: 'from-red-500 to-rose-600', icon: '🚀' },
];

const LEARNING_SOURCES = [
    { value: 'topic', label: 'Topic', icon: BookOpen },
    { value: 'repo', label: 'GitHub Repo', icon: GitBranch },
];

const SEARCH_HISTORY_KEY = 'questmap_search_history';
const MAX_SEARCH_HISTORY = 12;

const normalizeSuggestionValue = (value) => String(value || '').trim();

const getStoredSearchHistory = () => {
    try {
        const parsed = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const saveSearchHistoryItem = (item) => {
    const value = normalizeSuggestionValue(item.value);
    if (!value) return;

    const nextItem = {
        source_type: item.source_type || 'topic',
        value,
        skill_level: item.skill_level || 'beginner',
        updated_at: new Date().toISOString(),
    };

    const existing = getStoredSearchHistory();
    const deduped = existing.filter(entry => (
        entry?.source_type !== nextItem.source_type ||
        normalizeSuggestionValue(entry?.value).toLowerCase() !== value.toLowerCase()
    ));

    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify([nextItem, ...deduped].slice(0, MAX_SEARCH_HISTORY)));
};

const Profile = () => {
    const navigate = useNavigate();
    const [learningSource, setLearningSource] = useState('topic');
    const [topic, setTopic] = useState('');
    const [repoUrl, setRepoUrl] = useState('');
    const [skillLevel, setSkillLevel] = useState('beginner');
    const [background, setBackground] = useState('');
    const [goals, setGoals] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);
    const [quests, setQuests] = useState([]);
    const [loadingHistory, setLoadingHistory] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [documents, setDocuments] = useState([]);
    const [searchHistory, setSearchHistory] = useState([]);
    const [showSearchSuggestions, setShowSearchSuggestions] = useState(false);

    useEffect(() => {
        setSearchHistory(getStoredSearchHistory());
    }, []);

    const fetchDocuments = useCallback(async (uid) => {
        try {
            const res = await fetch(`${API_BASE}/user-documents/${uid}`);
            if (res.ok) setDocuments(await res.json());
        } catch (err) {
            console.error("Failed to fetch documents:", err);
        }
    }, []);

    const fetchQuests = useCallback(async (uid) => {
        setLoadingHistory(true);
        try {
            const res = await fetch(`${API_BASE}/user-quests/${uid}`);
            if (res.ok) {
                const data = await res.json();
                setQuests(data);
            }
        } catch (err) {
            console.error("Failed to fetch quests:", err);
        }
        setLoadingHistory(false);
    }, []);

    useEffect(() => {
        const unsubscribe = auth.onAuthStateChanged((user) => {
            setCurrentUser(user);
            if (user) {
                fetchQuests(user.uid);
                fetchDocuments(user.uid);
                
                // Trigger YouTube Subscription Sync to Supabase
                const ytToken = sessionStorage.getItem('yt_access_token');
                if (ytToken) {
                    fetch(`${API_BASE}/youtube/sync-subscriptions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: user.uid, ytAccessToken: ytToken })
                    }).catch(err => console.error("YouTube Sync Error:", err));
                }
            } else {
                // Fallback: fetch quests saved without login (matches Dashboard save logic)
                const fallbackUid = sessionStorage.getItem('questmap_uid') || 'anonymous';
                fetchQuests(fallbackUid);
            }
        });
        return unsubscribe;
    }, [fetchDocuments, fetchQuests]);

    const handleResumeQuest = (quest) => {
        const profileData = {
            ...quest.profileData,
            topic: quest.topic,
            skill_level: quest.skillLevel,
        };
        sessionStorage.setItem('questmap_profile', JSON.stringify(profileData));
        sessionStorage.setItem('questmap_cached_data', JSON.stringify({
            mapData: quest.mapData,
            recommendations: quest.recommendations,
            profileData: quest.profileData
        }));
        navigate('/dashboard');
    };

    const handleDeleteQuest = async (id) => {
        try {
            const res = await fetch(`${API_BASE}/quest/${id}`, { method: 'DELETE' });
            if (res.ok) {
                const uid = currentUser?.uid || sessionStorage.getItem('questmap_uid') || 'anonymous';
                fetchQuests(uid);
            }
        } catch (err) {
            console.error("Delete failed:", err);
        }
    };

    const handleLogout = async () => {
        try {
            await signOut(auth);
            sessionStorage.removeItem('questmap_profile');
            navigate('/');
        } catch (error) {
            console.error("Logout failed:", error);
        }
    };

    const handleSubmit = async (e) => {
        if (e) e.preventDefault();
        if (learningSource === 'topic' && !topic.trim()) return;
        if (learningSource === 'repo' && !repoUrl.trim()) return;

        setIsSubmitting(true);

        const profileData = {
            source_type: learningSource,
            topic: learningSource === 'repo' ? repoUrl.trim() : topic.trim(),
            repo_url: learningSource === 'repo' ? repoUrl.trim() : '',
            skill_level: skillLevel,
            background: background.trim(),
            goals: goals.trim(),
        };
        sessionStorage.removeItem('questmap_dashboard_cache');
        sessionStorage.removeItem('questmap_cached_data');
        sessionStorage.removeItem('questmap_node_cache');
        sessionStorage.setItem('questmap_profile', JSON.stringify(profileData));
        saveSearchHistoryItem({
            source_type: learningSource,
            value: learningSource === 'repo' ? repoUrl.trim() : topic.trim(),
            skill_level: skillLevel,
        });
        setSearchHistory(getStoredSearchHistory());

        navigate('/dashboard');
    };

    const isRepoMode = learningSource === 'repo';
    const isValid = isRepoMode ? repoUrl.trim().length > 0 : topic.trim().length > 0;
    const activeSearchValue = isRepoMode ? repoUrl : topic;
    const sourceSuggestions = useMemo(() => {
        const suggestions = [];
        const seen = new Set();
        const addSuggestion = ({ value, source_type, skill_level, label }) => {
            const normalizedValue = normalizeSuggestionValue(value);
            const normalizedType = source_type || 'topic';
            if (!normalizedValue || normalizedType !== learningSource) return;

            const key = `${normalizedType}:${normalizedValue.toLowerCase()}`;
            if (seen.has(key)) return;
            seen.add(key);
            suggestions.push({
                value: normalizedValue,
                source_type: normalizedType,
                skill_level: skill_level || 'beginner',
                label: label || (normalizedType === 'repo' ? 'Repository' : 'Previous topic'),
            });
        };

        searchHistory.forEach(entry => addSuggestion({
            value: entry.value,
            source_type: entry.source_type,
            skill_level: entry.skill_level,
            label: 'Recent search',
        }));

        try {
            const storedProfile = JSON.parse(sessionStorage.getItem('questmap_profile') || 'null');
            if (storedProfile) {
                addSuggestion({
                    value: storedProfile.source_type === 'repo' ? storedProfile.repo_url || storedProfile.topic : storedProfile.topic,
                    source_type: storedProfile.source_type || 'topic',
                    skill_level: storedProfile.skill_level,
                    label: 'Last profile',
                });
            }
        } catch {
            // Ignore malformed session data.
        }

        quests.forEach(quest => addSuggestion({
            value: quest?.profileData?.source_type === 'repo'
                ? quest?.profileData?.repo_url || quest.topic
                : quest.topic,
            source_type: quest?.profileData?.source_type || 'topic',
            skill_level: quest.skillLevel,
            label: 'Saved quest',
        }));

        const filter = activeSearchValue.trim().toLowerCase();
        return suggestions
            .filter(item => !filter || item.value.toLowerCase().includes(filter))
            .slice(0, 6);
    }, [activeSearchValue, learningSource, quests, searchHistory]);

    const handleSuggestionSelect = (suggestion) => {
        if (suggestion.source_type === 'repo') {
            setRepoUrl(suggestion.value);
        } else {
            setTopic(suggestion.value);
        }
        if (suggestion.skill_level) setSkillLevel(suggestion.skill_level);
        setShowSearchSuggestions(false);
    };

    return (
        <>
            <AnimatePresence>
                {isSubmitting && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[100]"
                    >
                        <TubesBackground className="w-full h-full flex items-center justify-center" enableClickInteraction={false}>
                            <div className="flex flex-col items-center justify-center h-full">
                                <LoadingState
                                    message="Synthesizing Knowledge Mesh"
                                    subMessage={isRepoMode ? 'Analyzing repository concept signals...' : `Analyzing neural pathways for ${topic}...`}
                                />
                            </div>
                        </TubesBackground>
                    </motion.div>
                )}
            </AnimatePresence>

            <div className="min-h-screen bg-[#0a0a0a] text-white relative overflow-hidden font-sans selection:bg-blue-500/30 flex flex-col">
                <div className="absolute inset-0 pointer-events-none">
                    <motion.div
                        animate={{
                            scale: [1, 1.2, 1],
                            opacity: [0.1, 0.15, 0.1],
                            x: [0, 50, 0]
                        }}
                        transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
                        className="absolute -top-[10%] -left-[10%] w-[50%] h-[50%] bg-blue-600/10 rounded-full blur-[120px]"
                    />
                    <motion.div
                        animate={{
                            scale: [1.3, 1, 1.3],
                            opacity: [0.08, 0.12, 0.08],
                            x: [0, -50, 0]
                        }}
                        transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
                        className="absolute -bottom-[10%] -right-[10%] w-[50%] h-[50%] bg-purple-600/10 rounded-full blur-[120px]"
                    />
                    <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay" />
                </div>

                <nav className="flex items-center justify-between px-8 py-6 max-w-screen-2xl mx-auto relative z-20 w-full flex-shrink-0">
                    <div className="flex items-center gap-4 group cursor-pointer" onClick={() => navigate('/')}>
                        <div className="bg-blue-600 p-2 rounded-xl shadow-2xl shadow-blue-600/40 group-hover:scale-110 transition-all duration-300">
                            <Compass className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-xl font-black tracking-tighter font-outfit uppercase">QuestMap</span>
                    </div>
                    {currentUser && (
                        <div className="flex items-center gap-4 bg-white/5 border border-white/5 px-4 py-2 rounded-2xl backdrop-blur-xl">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center font-black text-xs uppercase">
                                {currentUser.displayName?.charAt(0) || 'U'}
                            </div>
                            <span className="text-[10px] font-black text-white/60 uppercase tracking-widest hidden md:block">
                                {currentUser.displayName}
                            </span>
                            <LogOut className="w-4 h-4 text-white/30 hover:text-red-400 cursor-pointer transition-colors" onClick={handleLogout} />
                        </div>
                    )}
                </nav>

                <main className="flex-1 max-w-screen-xl mx-auto w-full px-8 py-4 relative z-10 flex flex-col justify-center">
                    <motion.div
                        initial={{ opacity: 0, scale: 0.95 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className="grid grid-cols-1 lg:grid-cols-2 gap-12 bg-black/40 border border-white/10 p-12 lg:p-16 rounded-[4rem] backdrop-blur-[60px] shadow-2xl relative"
                    >
                        <div className="lg:col-span-2 text-center lg:text-left mb-4">
                            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-black uppercase tracking-[0.3em] mb-4">
                                <Sparkles className="w-3 h-3" />
                                Personalized Neural Path
                            </div>
                            <h1 className="text-5xl lg:text-7xl font-black tracking-tighter leading-none font-outfit uppercase">
                                Forge your <br />
                                <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-500">
                                    mastery quest
                                </span>
                            </h1>
                        </div>

                        <div className="space-y-10">
                            <div className="space-y-4">
                                <label className="flex items-center gap-3 text-[11px] font-black text-blue-400 uppercase tracking-[0.3em] font-outfit">
                                    <Sparkles className="w-4 h-4" />
                                    Learning Source
                                </label>
                                <div className="grid grid-cols-2 gap-4">
                                    {LEARNING_SOURCES.map((source) => {
                                        const Icon = source.icon;
                                        const active = learningSource === source.value;
                                        return (
                                            <button
                                                key={source.value}
                                                type="button"
                                                onClick={() => setLearningSource(source.value)}
                                                className={`rounded-[1.5rem] border p-4 text-left transition-all ${
                                                    active
                                                        ? 'border-blue-500/50 bg-blue-500/10 shadow-[0_0_30px_rgba(59,130,246,0.16)]'
                                                        : 'border-white/5 bg-white/5 hover:border-white/20'
                                                }`}
                                            >
                                                <div className="flex items-center gap-3">
                                                    <Icon className={active ? 'w-4 h-4 text-blue-400' : 'w-4 h-4 text-white/30'} />
                                                    <span className="text-[11px] font-black uppercase tracking-widest text-white">{source.label}</span>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="space-y-4 group">
                                <label className="flex items-center gap-3 text-[11px] font-black text-blue-400 uppercase tracking-[0.3em] font-outfit">
                                    {isRepoMode ? <GitBranch className="w-4 h-4" /> : <BookOpen className="w-4 h-4" />}
                                    {isRepoMode ? 'GitHub Repository' : 'Knowledge Domain'}
                                </label>
                                <div className="relative">
                                    <input
                                        type={isRepoMode ? 'url' : 'text'}
                                        value={isRepoMode ? repoUrl : topic}
                                        onChange={(e) => {
                                            if (isRepoMode) setRepoUrl(e.target.value);
                                            else setTopic(e.target.value);
                                            setShowSearchSuggestions(true);
                                        }}
                                        onFocus={() => setShowSearchSuggestions(true)}
                                        onBlur={() => window.setTimeout(() => setShowSearchSuggestions(false), 120)}
                                        placeholder={isRepoMode ? 'https://github.com/org/repo' : 'What domain will you conquer today?'}
                                        autoComplete="off"
                                        className="w-full bg-white/5 border border-white/10 rounded-3xl py-6 px-10 pr-16 text-lg text-white font-medium placeholder:text-gray-700 focus:ring-2 focus:ring-blue-500/30 focus:border-blue-500/50 outline-none transition-all duration-300"
                                        required
                                    />
                                    <div className="absolute right-8 top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-500 rounded-full blur-[2px] animate-pulse" />
                                    <AnimatePresence>
                                        {showSearchSuggestions && sourceSuggestions.length > 0 && (
                                            <motion.div
                                                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                                exit={{ opacity: 0, y: -8, scale: 0.98 }}
                                                transition={{ duration: 0.16 }}
                                                className="absolute left-0 right-0 top-[calc(100%+0.75rem)] z-40 overflow-hidden rounded-3xl border border-white/10 bg-[#101014]/95 shadow-2xl shadow-black/40 backdrop-blur-2xl"
                                            >
                                                <div className="max-h-72 overflow-y-auto p-2 custom-scrollbar">
                                                    {sourceSuggestions.map((suggestion) => {
                                                        const SuggestionIcon = suggestion.source_type === 'repo' ? GitBranch : BookOpen;
                                                        return (
                                                            <button
                                                                key={`${suggestion.source_type}:${suggestion.value}`}
                                                                type="button"
                                                                onMouseDown={(event) => {
                                                                    event.preventDefault();
                                                                    handleSuggestionSelect(suggestion);
                                                                }}
                                                                className="w-full rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                                                            >
                                                                <div className="flex items-center gap-3">
                                                                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-2xl bg-blue-500/10 border border-blue-500/20">
                                                                        <SuggestionIcon className="h-4 w-4 text-blue-300" />
                                                                    </div>
                                                                    <div className="min-w-0 flex-1">
                                                                        <p className="truncate text-sm font-bold text-white">{suggestion.value}</p>
                                                                        <div className="mt-1 flex items-center gap-2">
                                                                            <span className="text-[9px] font-black uppercase tracking-widest text-white/35">{suggestion.label}</span>
                                                                            <span className="h-1 w-1 rounded-full bg-white/20" />
                                                                            <span className="text-[9px] font-black uppercase tracking-widest text-blue-300/80">{suggestion.skill_level}</span>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </button>
                                                        );
                                                    })}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            </div>

                            {!showHistory ? (
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <label className="flex items-center gap-3 text-[11px] font-black text-purple-400 uppercase tracking-[0.3em] font-outfit">
                                            <Target className="w-4 h-4" />
                                            Experience vector
                                        </label>
                                        <button
                                            onClick={() => setShowHistory(true)}
                                            className="text-[9px] font-black uppercase tracking-widest text-white/30 hover:text-blue-400 transition-colors flex items-center gap-2"
                                        >
                                            <History className="w-3.5 h-3.5" /> View Archives
                                        </button>
                                    </div>
                                    <div className="grid grid-cols-3 gap-4">
                                        {SKILL_LEVELS.map((level) => (
                                            <button
                                                key={level.value}
                                                type="button"
                                                onClick={() => setSkillLevel(level.value)}
                                                className={`relative rounded-[2rem] p-6 border text-center transition-all duration-500 group overflow-hidden ${skillLevel === level.value
                                                    ? 'border-blue-500/50 bg-blue-500/10 shadow-[0_0_40px_rgba(59,130,246,0.2)]'
                                                    : 'border-white/5 bg-white/5 hover:border-white/20'
                                                    }`}
                                            >
                                                <div className="relative z-10">
                                                    <span className="text-3xl mb-3 block group-hover:scale-125 transition-transform duration-500">{level.icon}</span>
                                                    <span className="text-white text-[11px] font-black block uppercase tracking-tighter font-outfit">{level.label}</span>
                                                </div>
                                                {skillLevel === level.value && (
                                                    <motion.div
                                                        layoutId="skill-blob"
                                                        className="absolute inset-0 bg-gradient-to-t from-blue-600/10 to-transparent pointer-events-none"
                                                    />
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <label className="flex items-center gap-3 text-[11px] font-black text-blue-400 uppercase tracking-[0.3em] font-outfit">
                                            <History className="w-4 h-4" />
                                            Neural Archives
                                        </label>
                                        <button
                                            onClick={() => setShowHistory(false)}
                                            className="text-[9px] font-black uppercase tracking-widest text-white/30 hover:text-blue-400 transition-colors"
                                        >
                                            Back to Forge
                                        </button>
                                    </div>
                                    <div className="max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                                        <QuestLog
                                            quests={quests}
                                            loading={loadingHistory}
                                            onResume={handleResumeQuest}
                                            onDelete={handleDeleteQuest}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="space-y-8 flex flex-col justify-between">
                            <div className="space-y-8">
                                <div className="space-y-4">
                                    <label className="flex items-center gap-3 text-[11px] font-black text-emerald-400 uppercase tracking-[0.3em] font-outfit">
                                        <User className="w-4 h-4" />
                                        Cognitive state <span className="text-white/20 font-black lowercase tracking-normal ml-2">(optional)</span>
                                    </label>
                                    <textarea
                                        value={background}
                                        onChange={(e) => setBackground(e.target.value)}
                                        placeholder="Describe your current mental model..."
                                        rows={2}
                                        className="w-full bg-white/5 border border-white/10 rounded-3xl py-5 px-8 text-base text-white/80 placeholder:text-gray-700 focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500/40 outline-none transition-all duration-300 resize-none"
                                    />
                                </div>

                                <div className="space-y-4">
                                    <label className="flex items-center gap-3 text-[11px] font-black text-amber-400 uppercase tracking-[0.3em] font-outfit">
                                        <Sparkles className="w-4 h-4" />
                                        End objective <span className="text-white/20 font-black lowercase tracking-normal ml-2">(optional)</span>
                                    </label>
                                    <textarea
                                        value={goals}
                                        onChange={(e) => setGoals(e.target.value)}
                                        placeholder="What is your definition of success?"
                                        rows={2}
                                        className="w-full bg-white/5 border border-white/10 rounded-3xl py-5 px-8 text-base text-white/80 placeholder:text-gray-700 focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500/40 outline-none transition-all duration-300 resize-none"
                                    />
                                </div>
                            </div>

                            {currentUser && (
                                <div className="space-y-4">
                                    <label className="flex items-center gap-3 text-[11px] font-black text-purple-400 uppercase tracking-[0.3em] font-outfit">
                                        <BookOpen className="w-4 h-4" />
                                        Context Upload <span className="text-white/20 font-black lowercase tracking-normal ml-2">(optional)</span>
                                    </label>
                                    <DocumentUpload
                                        userId={currentUser.uid}
                                        documents={documents}
                                        onDocumentsChange={() => fetchDocuments(currentUser.uid)}
                                    />
                                </div>
                            )}

                            {currentUser && (
                                <div className="space-y-4">
                                    <label className="flex items-center gap-3 text-[11px] font-black text-blue-400 uppercase tracking-[0.3em] font-outfit">
                                        <Globe className="w-4 h-4" />
                                        Article Domain Preferences <span className="text-white/20 font-black lowercase tracking-normal ml-2">(optional)</span>
                                    </label>
                                    <DomainPreferences userId={currentUser.uid} />
                                </div>
                            )}

                            <motion.button
                                type="submit"
                                onClick={handleSubmit}
                                disabled={!isValid || isSubmitting}
                                className={`w-full py-6 rounded-[2rem] font-black text-sm uppercase tracking-[0.4em] flex items-center justify-center gap-6 transition-all duration-500 group relative overflow-hidden ${isValid && !isSubmitting
                                    ? 'bg-white text-black shadow-[0_20px_60px_-15px_rgba(255,255,255,0.3)] hover:scale-[1.02] active:scale-[0.98]'
                                    : 'bg-white/5 text-white/20 border border-white/5'
                                    }`}
                            >
                                <AnimatePresence mode="wait">
                                    {isSubmitting ? (
                                        <motion.div
                                            key="submitting"
                                            initial={{ opacity: 0, scale: 0.8 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            className="flex items-center gap-4"
                                        >
                                            <div className="w-5 h-5 border-[3px] border-black/10 border-t-black rounded-full animate-spin" />
                                            Connecting to mesh...
                                        </motion.div>
                                    ) : (
                                        <motion.div
                                            key="idle"
                                            initial={{ opacity: 0 }}
                                            animate={{ opacity: 1 }}
                                            className="flex items-center gap-4"
                                        >
                                            {isRepoMode ? 'Analyze repository' : 'Generate neural map'}
                                            <ArrowRight className="w-5 h-5 group-hover:translate-x-3 transition-transform duration-300" />
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </motion.button>
                        </div>

                        <div className="lg:col-span-2 pt-10 border-t border-white/5 flex items-center justify-between pointer-events-none opacity-20">
                            <span className="text-[10px] font-black tracking-[1em] text-white">PROTO_ID: QMAP_RESTORE</span>
                            <div className="flex gap-2">
                                <div className="w-2 h-2 rounded-full bg-blue-500" />
                                <div className="w-2 h-2 rounded-full bg-purple-500" />
                                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                            </div>
                        </div>
                    </motion.div>
                </main>

                <div className="h-12 flex-shrink-0" />
            </div>
        </>
    );
};

export default Profile;
