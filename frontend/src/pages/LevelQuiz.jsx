import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Check, X, BrainCircuit, Sparkles, Lock } from 'lucide-react';
import { Timeline } from '../components/Timeline';
import LoadingState from '../components/LoadingState';
import { API_BASE } from '../config/api';
import { auth } from '../firebase';

const LevelQuiz = () => {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [quizData, setQuizData] = useState(null);
    const [profile, setProfile] = useState(null);
    const [currentLevel, setCurrentLevel] = useState(0); // 0 index = Level 1
    const [answers, setAnswers] = useState({}); // { levelIndex: selectedOptionIndex }
    const [feedback, setFeedback] = useState({}); // { levelIndex: 'success' | 'failure' }

    useEffect(() => {
        const fetchQuiz = async () => {
            const cachedProfileStr = sessionStorage.getItem('questmap_profile');
            if (!cachedProfileStr) {
                navigate('/profile');
                return;
            }
            const profile = JSON.parse(cachedProfileStr);
            setProfile(profile);

            try {
                const uid = auth.currentUser ? auth.currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');
                const res = await fetch(`${API_BASE}/generate-quiz`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        topic: profile.topic,
                        skill_level: profile.skill_level,
                        userId: uid,
                    })
                });

                if (res.ok) {
                    const data = await res.json();
                    setQuizData(data);
                }
            } catch (error) {
                console.error("Failed to generate quiz", error);
            }
            setLoading(false);
        };

        fetchQuiz();
    }, [navigate]);

    const handleAnswer = async (levelIndex, optionIndex, correctIndex, level) => {
        if (answers[levelIndex] !== undefined) return; // Already answered

        setAnswers(prev => ({ ...prev, [levelIndex]: optionIndex }));

        const isCorrect = optionIndex === correctIndex;
        setFeedback(prev => ({ ...prev, [levelIndex]: isCorrect ? 'success' : 'failure' }));

        const uid = auth.currentUser ? auth.currentUser.uid : (sessionStorage.getItem('questmap_uid') || 'anonymous');
        if (profile?.topic) {
            fetch(`${API_BASE}/mastery/attempt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: uid,
                    topic: profile.topic,
                    nodeLabel: 'overall',
                    activityType: 'quiz',
                    itemId: `level-${level?.level_number || levelIndex + 1}`,
                    itemType: 'multiple_choice',
                    question: level?.question || '',
                    selectedAnswer: optionIndex,
                    correctAnswer: correctIndex,
                    isCorrect,
                    concepts: [level?.title || profile.topic],
                    confidence: 'low',
                    validationStatus: 'ungrounded_exploratory',
                }),
            }).catch(err => console.warn('Failed to submit quiz mastery attempt:', err));
        }

        if (isCorrect) {
            // Unlock next level after a short delay
            setTimeout(() => {
                const nextLevel = levelIndex + 1;
                if (nextLevel < quizData.levels.length) {
                    setCurrentLevel(nextLevel);
                } else {
                    setCurrentLevel(999); // Mastery complete
                }
            }, 1500);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
                <LoadingState message="Constructing Quiz Dimensions" subMessage="Calibrating difficulty..." />
            </div>
        );
    }

    if (!quizData || !quizData.levels) {
        return (
            <div className="min-h-screen bg-[#0a0a0a] text-white flex flex-col items-center justify-center">
                <p>Failed to load mastery check.</p>
                <button onClick={() => navigate('/dashboard')} className="mt-4 text-blue-400">Return to Dashboard</button>
            </div>
        );
    }

    const timelineData = quizData.levels.map((level, index) => {
        const isUnlocked = index <= currentLevel;
        const hasAnswered = answers[index] !== undefined;
        const isCorrect = feedback[index] === 'success';

        return {
            unlocked: isUnlocked,
            title: `Level ${level.level_number || index + 1}`,
            content: (
                <div className={`p-6 rounded-[2rem] border transition-all duration-500 ${isUnlocked
                        ? 'bg-white/5 border-white/10 shadow-[0_10px_40px_-20px_rgba(0,0,0,0.5)]'
                        : 'bg-black/50 border-white/5 opacity-40 grayscale blur-[1px]'
                    }`}>
                    {!isUnlocked ? (
                        <div className="flex flex-col items-center justify-center py-12 text-neutral-500">
                            <Lock className="w-8 h-8 mb-4 opacity-50" />
                            <p className="font-outfit text-sm uppercase tracking-widest font-black">LOCKED</p>
                            <p className="text-xs mt-2 opacity-50">Beat Level {index} to unlock</p>
                        </div>
                    ) : (
                        <div className="space-y-6">
                            <h4 className="text-2xl font-black text-white font-outfit uppercase tracking-tighter">
                                {level.title}
                            </h4>
                            <p className="text-white/60 text-sm">{level.description}</p>

                            <div className="bg-blue-500/10 border border-blue-500/20 p-5 rounded-3xl mt-6">
                                <p className="text-white/90 font-medium text-lg leading-relaxed">
                                    {level.question}
                                </p>
                            </div>

                            <div className="space-y-3 mt-6">
                                {level.options.map((opt, optIndex) => {
                                    const isSelected = answers[index] === optIndex;
                                    const isActuallyCorrect = optIndex === level.correct_index;

                                    let btnStyle = "bg-white/5 border-white/10 hover:bg-white/10 text-white/80";

                                    if (hasAnswered) {
                                        if (isSelected && isActuallyCorrect) btnStyle = "bg-emerald-500/20 border-emerald-500/50 text-emerald-400";
                                        else if (isSelected && !isActuallyCorrect) btnStyle = "bg-red-500/20 border-red-500/50 text-red-400";
                                        else if (isActuallyCorrect) btnStyle = "bg-emerald-500/10 border-emerald-500/30 text-emerald-400/50";
                                        else btnStyle = "bg-black/20 border-white/5 text-white/30";
                                    }

                                    return (
                                        <button
                                            key={optIndex}
                                            onClick={() => handleAnswer(index, optIndex, level.correct_index, level)}
                                            disabled={hasAnswered}
                                            className={`w-full text-left p-4 rounded-2xl border transition-all duration-300 flex items-center justify-between group ${btnStyle}`}
                                        >
                                            <span className="font-medium">{opt}</span>
                                            {hasAnswered && isSelected && isActuallyCorrect && <Check className="w-5 h-5 text-emerald-400" />}
                                            {hasAnswered && isSelected && !isActuallyCorrect && <X className="w-5 h-5 text-red-400" />}
                                        </button>
                                    );
                                })}
                            </div>

                            <AnimatePresence>
                                {hasAnswered && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        className={`mt-6 p-5 rounded-2xl border ${isCorrect ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'
                                            }`}
                                    >
                                        <div className="flex items-start gap-4">
                                            {isCorrect ? <Sparkles className="w-6 h-6 text-emerald-400 flex-shrink-0" /> : <BrainCircuit className="w-6 h-6 text-red-400 flex-shrink-0" />}
                                            <div>
                                                <h5 className={`font-black uppercase tracking-widest text-xs mb-1 ${isCorrect ? 'text-emerald-400' : 'text-red-400'}`}>
                                                    {isCorrect ? 'Correct Analysis' : 'Neural Misfire'}
                                                </h5>
                                                <p className="text-white/80 text-sm">
                                                    {isCorrect ? level.success_message : level.failure_message}
                                                </p>
                                                {!isCorrect && (
                                                    <button
                                                        onClick={() => {
                                                            const newAnswers = { ...answers };
                                                            const newFeedback = { ...feedback };
                                                            delete newAnswers[index];
                                                            delete newFeedback[index];
                                                            setAnswers(newAnswers);
                                                            setFeedback(newFeedback);
                                                        }}
                                                        className="mt-3 text-[10px] uppercase font-black tracking-widest text-white/40 hover:text-white transition-colors"
                                                    >
                                                        Recalibrate & Retry
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    )}
                </div>
            )
        };
    });

    // Add mastery completion node
    if (currentLevel === 999) {
        timelineData.push({
            unlocked: true,
            title: "Mastery",
            content: (
                <motion.div
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="p-10 rounded-[2rem] bg-gradient-to-br from-blue-500/20 to-purple-500/20 border border-blue-500/30 text-center"
                >
                    <Sparkles className="w-16 h-16 text-blue-400 mx-auto mb-6 animate-pulse" />
                    <h4 className="text-4xl font-black text-white font-outfit uppercase tracking-tighter mb-4">
                        Domain Mastered
                    </h4>
                    <p className="text-blue-200 mb-8">You have successfully cleared all neural pathways.</p>
                    <button
                        onClick={() => navigate('/dashboard')}
                        className="bg-white text-black px-8 py-4 rounded-full font-black uppercase tracking-widest text-sm hover:scale-105 transition-transform"
                    >
                        Return to Dashboard
                    </button>
                </motion.div>
            )
        });
    }

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white">
            <nav className="fixed top-0 w-full z-50 bg-black/50 backdrop-blur-xl border-b border-white/5 py-4 px-8 flex items-center justify-between">
                <button
                    onClick={() => navigate('/dashboard')}
                    className="flex items-center gap-2 text-white/50 hover:text-white transition-colors text-xs font-black uppercase tracking-widest"
                >
                    <ArrowLeft className="w-4 h-4" /> Exit Simulation
                </button>
                <div className="text-xs font-black uppercase tracking-widest text-blue-400">
                    {quizData.quiz_title}
                </div>
            </nav>

            <div className="pt-20">
                <Timeline data={timelineData} />
            </div>
        </div>
    );
};

export default LevelQuiz;
