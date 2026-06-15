import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Code, BookOpen, HelpCircle, ChevronDown, ChevronUp, ShieldCheck, AlertTriangle } from 'lucide-react';
import { API_BASE } from '../config/api';

// ─── Multiple Choice ────────────────────────────────────────────────────────

const MultipleChoice = ({ scenario, onAttempt, onRequestRemediation }) => {
    const [selected, setSelected] = useState(null);
    const [showExplanation, setShowExplanation] = useState(false);
    const [remediation, setRemediation] = useState(null);

    const isCorrect = selected === scenario.correct_answer;
    const hasAnswered = selected !== null;

    return (
        <div className="space-y-3">
            <p className="text-white text-sm font-medium leading-relaxed">{scenario.question}</p>
            <div className="space-y-2">
                {(scenario.options || []).map((opt, i) => {
                    let optClass = 'border-gray-700 hover:border-gray-500 bg-gray-800/40';
                    if (hasAnswered) {
                        if (i === scenario.correct_answer) optClass = 'border-green-500/50 bg-green-500/10';
                        else if (i === selected) optClass = 'border-red-500/50 bg-red-500/10';
                        else optClass = 'border-gray-800 bg-gray-900/30 opacity-50';
                    }

                    return (
                        <button
                            key={i}
                            onClick={async () => {
                                if (hasAnswered) return;
                                setSelected(i);
                                setShowExplanation(true);
                                const result = await onAttempt?.(scenario, i);
                                if (result?.remediation) setRemediation(result.remediation);
                            }}
                            disabled={hasAnswered}
                            className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all flex items-center gap-3 ${optClass}`}
                        >
                            <span className="w-6 h-6 rounded-full border border-gray-600 flex items-center justify-center text-[10px] font-bold text-gray-400 flex-shrink-0">
                                {String.fromCharCode(65 + i)}
                            </span>
                            <span className={hasAnswered && i === scenario.correct_answer ? 'text-green-300' : hasAnswered && i === selected ? 'text-red-300' : 'text-gray-300'}>
                                {opt}
                            </span>
                            {hasAnswered && i === scenario.correct_answer && <CheckCircle className="w-4 h-4 text-green-400 ml-auto flex-shrink-0" />}
                            {hasAnswered && i === selected && i !== scenario.correct_answer && <XCircle className="w-4 h-4 text-red-400 ml-auto flex-shrink-0" />}
                        </button>
                    );
                })}
            </div>
            <AnimatePresence>
                {showExplanation && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                    >
                        <div className={`p-3 rounded-xl text-xs leading-relaxed ${isCorrect ? 'bg-green-500/10 border border-green-500/20 text-green-300' : 'bg-amber-500/10 border border-amber-500/20 text-amber-300'}`}>
                            <p className="font-semibold mb-1">{isCorrect ? '✅ Correct!' : '❌ Not quite.'}</p>
                            <p className="text-gray-300">{scenario.explanation}</p>
                        </div>
                        {remediation && (
                            <div className="mt-2 p-3 rounded-xl text-xs leading-relaxed bg-blue-500/10 border border-blue-500/20 text-blue-200">
                                <p className="font-semibold mb-1">{remediation.title}</p>
                                <p className="text-gray-300">{remediation.review_task}</p>
                                <p className="text-gray-400 mt-1">{remediation.practice_task}</p>
                                <button
                                    type="button"
                                    onClick={() => onRequestRemediation?.(remediation)}
                                    className="mt-3 rounded-lg bg-blue-500/20 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-blue-200 hover:bg-blue-500/30"
                                >
                                    Generate Drill
                                </button>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Scenario Based ─────────────────────────────────────────────────────────

const ScenarioBased = ({ scenario, onAttempt, onRequestRemediation }) => {
    const [showSolution, setShowSolution] = useState(false);
    const [selfCheck, setSelfCheck] = useState(null);
    const [remediation, setRemediation] = useState(null);

    const handleSelfCheck = async (isCorrect) => {
        if (selfCheck !== null) return;
        setSelfCheck(isCorrect);
        const result = await onAttempt?.(scenario, isCorrect ? 'self_correct' : 'needs_review', isCorrect);
        if (result?.remediation) setRemediation(result.remediation);
    };

    return (
        <div className="space-y-3">
            <p className="text-white text-sm font-medium leading-relaxed">{scenario.question}</p>
            {scenario.context && (
                <div className="bg-gray-900/60 border border-gray-700/50 rounded-xl p-3 text-xs text-gray-400 leading-relaxed">
                    <span className="text-gray-500 font-semibold text-[10px] uppercase tracking-wider block mb-1">Context</span>
                    {scenario.context}
                </div>
            )}
            <button
                onClick={() => setShowSolution(!showSolution)}
                className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
            >
                {showSolution ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                {showSolution ? 'Hide Solution' : 'Show Solution'}
            </button>
            <AnimatePresence>
                {showSolution && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="space-y-2">
                            <div className="bg-blue-500/5 border border-blue-500/15 rounded-xl p-3 text-xs text-gray-300 leading-relaxed">
                                <span className="text-blue-400 font-semibold text-[10px] uppercase tracking-wider block mb-1">Solution</span>
                                {scenario.solution}
                            </div>
                            {scenario.key_takeaway && (
                                <div className="bg-purple-500/5 border border-purple-500/15 rounded-xl p-3 text-xs text-purple-300 leading-relaxed">
                                    <span className="text-purple-400 font-semibold text-[10px] uppercase tracking-wider block mb-1">💡 Key Takeaway</span>
                                    {scenario.key_takeaway}
                                </div>
                            )}
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={selfCheck !== null}
                                    onClick={() => handleSelfCheck(true)}
                                    className="rounded-lg bg-emerald-500/15 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-300 disabled:opacity-50"
                                >
                                    Got it
                                </button>
                                <button
                                    type="button"
                                    disabled={selfCheck !== null}
                                    onClick={() => handleSelfCheck(false)}
                                    className="rounded-lg bg-amber-500/15 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-300 disabled:opacity-50"
                                >
                                    Needs review
                                </button>
                            </div>
                            {remediation && (
                                <div className="bg-blue-500/5 border border-blue-500/15 rounded-xl p-3 text-xs text-blue-200 leading-relaxed">
                                    <span className="text-blue-300 font-semibold text-[10px] uppercase tracking-wider block mb-1">{remediation.title}</span>
                                    {remediation.review_task}
                                    <button
                                        type="button"
                                        onClick={() => onRequestRemediation?.(remediation)}
                                        className="mt-3 block rounded-lg bg-blue-500/20 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-blue-200 hover:bg-blue-500/30"
                                    >
                                        Generate Drill
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Code Challenge ─────────────────────────────────────────────────────────

const CodeChallenge = ({ scenario, onAttempt, onRequestRemediation }) => {
    const [showSolution, setShowSolution] = useState(false);
    const [selfCheck, setSelfCheck] = useState(null);
    const [remediation, setRemediation] = useState(null);

    const handleSelfCheck = async (isCorrect) => {
        if (selfCheck !== null) return;
        setSelfCheck(isCorrect);
        const result = await onAttempt?.(scenario, isCorrect ? 'self_correct' : 'needs_review', isCorrect);
        if (result?.remediation) setRemediation(result.remediation);
    };

    return (
        <div className="space-y-3">
            <p className="text-white text-sm font-medium leading-relaxed">{scenario.question}</p>
            {scenario.starter_code && (
                <div className="bg-gray-950 border border-gray-700/50 rounded-xl p-4 overflow-x-auto">
                    <span className="text-gray-500 font-semibold text-[10px] uppercase tracking-wider block mb-2">Starter Code</span>
                    <pre className="text-xs text-green-300 font-mono whitespace-pre-wrap">{scenario.starter_code}</pre>
                </div>
            )}
            <button
                onClick={() => setShowSolution(!showSolution)}
                className="flex items-center gap-2 text-xs text-emerald-400 hover:text-emerald-300 transition-colors font-medium"
            >
                <Code className="w-3.5 h-3.5" />
                {showSolution ? 'Hide Solution' : 'View Solution'}
            </button>
            <AnimatePresence>
                {showSolution && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        className="overflow-hidden space-y-2"
                    >
                        <div className="bg-gray-950 border border-emerald-500/20 rounded-xl p-4 overflow-x-auto">
                            <span className="text-emerald-400 font-semibold text-[10px] uppercase tracking-wider block mb-2">Solution</span>
                            <pre className="text-xs text-emerald-300 font-mono whitespace-pre-wrap">{scenario.solution_code}</pre>
                        </div>
                        {scenario.explanation && (
                            <div className="bg-emerald-500/5 border border-emerald-500/15 rounded-xl p-3 text-xs text-gray-300 leading-relaxed">
                                {scenario.explanation}
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                disabled={selfCheck !== null}
                                onClick={() => handleSelfCheck(true)}
                                className="rounded-lg bg-emerald-500/15 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-emerald-300 disabled:opacity-50"
                            >
                                Solution matched
                            </button>
                            <button
                                type="button"
                                disabled={selfCheck !== null}
                                onClick={() => handleSelfCheck(false)}
                                className="rounded-lg bg-amber-500/15 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-300 disabled:opacity-50"
                            >
                                Needs review
                            </button>
                        </div>
                        {remediation && (
                            <div className="bg-blue-500/5 border border-blue-500/15 rounded-xl p-3 text-xs text-blue-200 leading-relaxed">
                                <span className="text-blue-300 font-semibold text-[10px] uppercase tracking-wider block mb-1">{remediation.title}</span>
                                {remediation.review_task}
                                <button
                                    type="button"
                                    onClick={() => onRequestRemediation?.(remediation)}
                                    className="mt-3 block rounded-lg bg-blue-500/20 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-blue-200 hover:bg-blue-500/30"
                                >
                                    Generate Drill
                                </button>
                            </div>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Difficulty Badge ───────────────────────────────────────────────────────

const DifficultyBadge = ({ difficulty }) => {
    const colors = {
        beginner: 'bg-green-500/15 text-green-400 border-green-500/20',
        intermediate: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/20',
        advanced: 'bg-red-500/15 text-red-400 border-red-500/20',
    };
    return (
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${colors[difficulty] || colors.beginner}`}>
            {difficulty}
        </span>
    );
};

// ─── Type Icon ──────────────────────────────────────────────────────────────

const TypeIcon = ({ type }) => {
    const icons = {
        multiple_choice: <HelpCircle className="w-4 h-4 text-blue-400" />,
        scenario: <BookOpen className="w-4 h-4 text-purple-400" />,
        code_challenge: <Code className="w-4 h-4 text-emerald-400" />,
    };
    return icons[type] || icons.multiple_choice;
};

const GroundingBadge = ({ scenario }) => {
    const status = scenario.validation_status || 'ungrounded_exploratory';
    const isSupported = status === 'source_supported';
    const needsReview = status === 'needs_source_review';

    return (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${
            isSupported
                ? 'bg-blue-500/15 text-blue-400 border-blue-500/20'
                : needsReview
                    ? 'bg-amber-500/15 text-amber-400 border-amber-500/20'
                    : 'bg-gray-500/15 text-gray-400 border-gray-500/20'
        }`}>
            {isSupported ? <ShieldCheck className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
            {isSupported ? 'Source backed' : needsReview ? 'Needs source review' : 'Exploratory'}
        </span>
    );
};

const PracticeGroundingSummary = ({ summary }) => {
    if (!summary) return null;

    const badgeClass = summary.coverage_level === 'high'
        ? 'bg-blue-500/10 border-blue-500/20 text-blue-300'
        : summary.coverage_level === 'medium'
            ? 'bg-amber-500/10 border-amber-500/20 text-amber-300'
            : 'bg-gray-500/10 border-gray-500/20 text-gray-300';

    return (
        <div className={`rounded-2xl border p-4 ${badgeClass}`}>
            <div className="flex items-center gap-2 mb-1">
                <ShieldCheck className="w-4 h-4" />
                <span className="text-[10px] font-black uppercase tracking-widest">
                    Source coverage: {summary.coverage_level}
                </span>
            </div>
            <p className="text-[11px] leading-relaxed opacity-85">
                {summary.fact_count} source-backed facts from {summary.trusted_source_count} extractable source(s).
                {summary.metadata_only_source_count > 0 ? ` ${summary.metadata_only_source_count} discovered resource(s) are metadata-only.` : ''}
            </p>
            {summary.warning && (
                <p className="text-[11px] leading-relaxed mt-2 opacity-85">{summary.warning}</p>
            )}
        </div>
    );
};

const SourceEvidence = ({ scenario, facts = [] }) => {
    const citedFacts = (scenario.source_fact_ids || [])
        .map(id => facts.find(fact => fact.fact_id === id))
        .filter(Boolean);

    if (citedFacts.length === 0) return null;

    return (
        <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-3 text-[11px] text-gray-400 leading-relaxed">
            <span className="block text-blue-400 font-bold text-[10px] uppercase tracking-wider mb-1">Source evidence</span>
            <div className="space-y-1.5">
                {citedFacts.slice(0, 2).map(fact => (
                    <p key={fact.fact_id}>
                        <span className="text-blue-300 font-semibold">{fact.fact_id}</span>: {fact.claim}
                    </p>
                ))}
            </div>
        </div>
    );
};

const MasterySummary = ({ summary }) => {
    if (!summary) return null;

    const accuracy = Math.round((summary.accuracy || 0) * 100);
    return (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-emerald-200">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-black uppercase tracking-widest">
                    Mastery: {summary.mastery_level}
                </span>
                <span className="text-[10px] font-bold">{accuracy}% accuracy</span>
            </div>
            <p className="mt-1 text-[11px] text-gray-300">
                {summary.correct_attempts || 0}/{summary.total_attempts || 0} recent attempts correct.
                {summary.weak_concepts?.length > 0 ? ` Focus: ${summary.weak_concepts.map(item => item.concept).join(', ')}` : ''}
            </p>
        </div>
    );
};

// ─── Main Panel ─────────────────────────────────────────────────────────────

const PracticePanel = ({ practiceData, loading, selectedNode, masteryContext }) => {
    const [masterySummary, setMasterySummary] = useState(null);
    const [remediationPractice, setRemediationPractice] = useState(null);
    const [remediationLoading, setRemediationLoading] = useState(false);

    const submitAttempt = async (scenario, selectedAnswer, correctnessOverride = null) => {
        if (!masteryContext?.userId || !masteryContext?.topic) return null;

        const isCorrect = typeof correctnessOverride === 'boolean'
            ? correctnessOverride
            : selectedAnswer === scenario.correct_answer;
        try {
            const res = await fetch(`${API_BASE}/mastery/attempt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: masteryContext.userId,
                    topic: masteryContext.topic,
                    nodeLabel: selectedNode?.label || 'overall',
                    activityType: 'practice',
                    itemId: String(scenario.id || scenario.question || ''),
                    itemType: scenario.type || 'multiple_choice',
                    question: scenario.question,
                    selectedAnswer,
                    correctAnswer: scenario.correct_answer,
                    isCorrect,
                    concepts: selectedNode?.key_concepts || [],
                    sourceFactIds: scenario.source_fact_ids || [],
                    confidence: scenario.confidence || 'low',
                    validationStatus: scenario.validation_status || 'ungrounded_exploratory',
                }),
            });
            const data = await res.json();
            if (!res.ok && !data.remediation) return null;
            if (data.mastery_summary) setMasterySummary(data.mastery_summary);
            return data;
        } catch (err) {
            console.warn('Failed to submit mastery attempt:', err);
            return null;
        }
    };

    const requestRemediationPractice = async (remediation) => {
        if (!masteryContext?.userId || !masteryContext?.topic || !remediation) return;

        setRemediationLoading(true);
        try {
            const res = await fetch(`${API_BASE}/mastery/remediation-practice`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: masteryContext.userId,
                    topic: masteryContext.topic,
                    nodeLabel: selectedNode?.label || 'overall',
                    concepts: remediation.focus_concepts || selectedNode?.key_concepts || [],
                    skill_level: masteryContext.skillLevel || 'beginner',
                }),
            });
            if (!res.ok) return;
            const data = await res.json();
            setRemediationPractice(data);
        } catch (err) {
            console.warn('Failed to generate remediation practice:', err);
        } finally {
            setRemediationLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="space-y-4">
                {selectedNode && (
                    <div className="flex items-center gap-2 mb-6 animate-pulse">
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-gray-500">
                            Generating Practice for: {selectedNode.label}
                        </span>
                    </div>
                )}
                {[1, 2, 3].map(i => (
                    <div key={i} className="animate-pulse bg-gray-800/40 rounded-2xl h-32 border border-gray-700/30" />
                ))}
            </div>
        );
    }

    if (!practiceData?.scenarios?.length) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <BookOpen className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-sm italic">Click a node on the map to generate practice scenarios</p>
            </div>
        );
    }

    return (
        <div className="space-y-4 overflow-y-auto max-h-[calc(100vh-320px)] pr-1 custom-scrollbar">
            {selectedNode && (
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                        Practice: {selectedNode.label}
                    </span>
                </div>
            )}
            <PracticeGroundingSummary summary={practiceData.grounding_summary} />
            <MasterySummary summary={masterySummary} />
            {practiceData.practice_title && (
                <h3 className="text-white font-bold text-base">{practiceData.practice_title}</h3>
            )}
            {remediationLoading && (
                <div className="rounded-2xl border border-blue-500/20 bg-blue-500/10 p-4 text-[11px] font-black uppercase tracking-widest text-blue-300">
                    Generating remediation drill...
                </div>
            )}
            {remediationPractice?.scenarios?.length > 0 && (
                <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4">
                    <h3 className="text-blue-200 font-bold text-sm mb-3">{remediationPractice.practice_title || 'Remediation Drill'}</h3>
                    <div className="space-y-4">
                        {remediationPractice.scenarios.map((scenario, i) => (
                            <div key={scenario.id || i} className="rounded-xl border border-blue-500/10 bg-gray-900/40 p-4">
                                <MultipleChoice
                                    scenario={scenario}
                                    onAttempt={submitAttempt}
                                    onRequestRemediation={requestRemediationPractice}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {practiceData.scenarios.map((scenario, i) => (
                <motion.div
                    key={scenario.id || i}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="bg-gray-800/50 border border-gray-700/40 rounded-2xl p-5"
                >
                    {/* Scenario Header */}
                    <div className="flex items-center gap-2 mb-3">
                        <TypeIcon type={scenario.type} />
                        <span className="text-gray-400 text-[10px] font-bold uppercase tracking-wider">
                            {(scenario.type || '').replace('_', ' ')}
                        </span>
                        <DifficultyBadge difficulty={scenario.difficulty} />
                        <GroundingBadge scenario={scenario} />
                        <span className="text-gray-600 text-[10px] ml-auto">#{i + 1}</span>
                    </div>

                    {/* Scenario Content */}
                    {scenario.type === 'multiple_choice' && (
                        <MultipleChoice
                            scenario={scenario}
                            onAttempt={submitAttempt}
                            onRequestRemediation={requestRemediationPractice}
                        />
                    )}
                    {scenario.type === 'scenario' && (
                        <ScenarioBased
                            scenario={scenario}
                            onAttempt={submitAttempt}
                            onRequestRemediation={requestRemediationPractice}
                        />
                    )}
                    {scenario.type === 'code_challenge' && (
                        <CodeChallenge
                            scenario={scenario}
                            onAttempt={submitAttempt}
                            onRequestRemediation={requestRemediationPractice}
                        />
                    )}
                    <div className="mt-3">
                        <SourceEvidence scenario={scenario} facts={practiceData.source_facts} />
                    </div>
                </motion.div>
            ))}
        </div>
    );
};

export default PracticePanel;
