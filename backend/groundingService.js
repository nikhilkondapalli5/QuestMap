const MAX_FACTS = 24;
const MIN_HIGH_COVERAGE_FACTS = 12;
const MIN_MEDIUM_COVERAGE_FACTS = 5;
const MAX_SOURCE_MANIFEST_ITEMS = 12;
const OFFICIAL_DOMAIN_PATTERNS = [
    /\.edu$/i,
    /\.gov$/i,
    /\.org$/i,
    /docs\./i,
    /developer\./i,
    /learn\./i,
    /wikipedia\.org$/i,
    /nature\.com$/i,
    /science\.org$/i,
    /arxiv\.org$/i,
    /nih\.gov$/i,
    /nasa\.gov$/i,
    /mit\.edu$/i,
    /stanford\.edu$/i,
];

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function keywordSet(...values) {
    const stopWords = new Set([
        'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'being',
        'between', 'but', 'can', 'could', 'does', 'for', 'from', 'has', 'have',
        'how', 'into', 'its', 'itself', 'more', 'most', 'not', 'one', 'only',
        'that', 'the', 'their', 'then', 'there', 'these', 'this', 'through',
        'using', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
    ]);

    return new Set(
        values
            .join(' ')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(word => word.length > 2 && !stopWords.has(word))
    );
}

function scoreSourceTrust({ domain = '', title = '', url = '' }) {
    const haystack = `${domain} ${title} ${url}`.toLowerCase();
    if (!haystack.trim()) return { trust_tier: 'discovered_metadata', trust_score: 35 };

    if (OFFICIAL_DOMAIN_PATTERNS.some(pattern => pattern.test(domain) || pattern.test(haystack))) {
        return { trust_tier: 'authoritative_metadata', trust_score: 80 };
    }

    if (/medium\.com|substack\.com|blogspot\.com|wordpress\.com|reddit\.com|quora\.com/.test(haystack)) {
        return { trust_tier: 'community_or_blog_metadata', trust_score: 25 };
    }

    return { trust_tier: 'discovered_metadata', trust_score: 45 };
}

function classifyAccess(source) {
    if (source.kind === 'uploaded_source') {
        return {
            access_mode: 'full_text_allowed',
            can_extract_facts: true,
            can_store_content: true,
            source_role: 'domain_authority',
            reason: 'User-uploaded source material is available in the project RAG store.',
        };
    }

    if (source.kind === 'uploaded_context') {
        return {
            access_mode: 'full_text_allowed',
            can_extract_facts: false,
            can_store_content: true,
            source_role: 'learner_context',
            reason: 'User context can personalize the lesson but is not treated as domain authority.',
        };
    }

    if (source.access_mode) {
        return {
            access_mode: source.access_mode,
            can_extract_facts: Boolean(source.can_extract_facts),
            can_store_content: Boolean(source.can_store_content),
            source_role: source.source_role || 'recommended_resource',
            reason: source.access_reason || source.reason || 'Discovered resource metadata is available, but content is not ingested as factual evidence.',
        };
    }

    return {
        access_mode: 'metadata_only',
        can_extract_facts: false,
        can_store_content: false,
        source_role: 'recommended_resource',
        reason: 'Discovered URL metadata can recommend a resource, but it is not ingested as factual evidence.',
    };
}

function buildSourceCandidates({ sourceMaterials = [], contextMaterials = [], articles = [] }) {
    const uploadedSources = sourceMaterials.map((material, index) => ({
        id: `source_${index + 1}`,
        kind: 'uploaded_source',
        title: material.filename || `Uploaded source ${index + 1}`,
        url: null,
        domain: 'user-uploaded',
        snippet: normalizeText(material.content).slice(0, 320),
        content: normalizeText(material.content),
        trust_tier: 'user_source',
        discovery_method: 'rag_uploaded_source',
    }));

    const personalContext = contextMaterials.map((material, index) => ({
        id: `context_${index + 1}`,
        kind: 'uploaded_context',
        title: material.filename || `Learner context ${index + 1}`,
        url: null,
        domain: 'user-uploaded',
        snippet: normalizeText(material.content).slice(0, 320),
        content: normalizeText(material.content),
        trust_tier: 'learner_context',
        discovery_method: 'rag_uploaded_context',
    }));

    const articleSources = articles.map((article, index) => {
        const trust = scoreSourceTrust({
            domain: article.source || article.domain || '',
            title: article.title || '',
            url: article.url || '',
        });

        return {
            id: `article_${index + 1}`,
            kind: 'discovered_article',
            title: article.title || article.source || `Article ${index + 1}`,
            url: article.url || null,
            domain: article.source || article.domain || null,
            snippet: article.why_relevant || '',
            content: '',
            trust_tier: article.trust_tier || trust.trust_tier,
            trust_score: article.trust_score || trust.trust_score,
            discovery_method: 'gemini_google_search_grounding',
            access_mode: article.access_mode || 'metadata_only',
            can_extract_facts: false,
            can_store_content: false,
            source_role: 'recommended_resource',
            access_reason: article.access_reason,
            permission_basis: article.permission_basis,
        };
    });

    return [...uploadedSources, ...personalContext, ...articleSources].map(source => ({
        ...source,
        ...classifyAccess(source),
    }));
}

function splitIntoEvidenceSentences(content) {
    return normalizeText(content)
        .split(/(?<=[.!?])\s+/)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 45 && sentence.length <= 420);
}

function scoreSentence(sentence, terms) {
    const normalized = sentence.toLowerCase();
    let score = 0;
    for (const term of terms) {
        if (normalized.includes(term)) score += 1;
    }
    return score;
}

function compileFacts({ topic, nodeLabel, keyConcepts = [], sources = [] }) {
    const terms = keywordSet(topic, nodeLabel, ...(keyConcepts || []));
    const facts = [];

    for (const source of sources) {
        if (!source.can_extract_facts || !source.content) continue;

        const scored = splitIntoEvidenceSentences(source.content)
            .map((sentence, sentenceIndex) => ({
                sentence,
                sentenceIndex,
                score: scoreSentence(sentence, terms),
            }))
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score || a.sentenceIndex - b.sentenceIndex)
            .slice(0, 6);

        for (const item of scored) {
            if (facts.length >= MAX_FACTS) break;
            facts.push({
                fact_id: `fact_${facts.length + 1}`,
                claim: item.sentence,
                concept: nodeLabel || topic,
                source_id: source.id,
                source_title: source.title,
                source_url: source.url,
                source_type: source.kind,
                source_chunk: item.sentence,
                citation: source.url ? `${source.title} (${source.url})` : source.title,
                confidence: source.trust_tier === 'user_source' ? 'high' : 'medium',
                trust_tier: source.trust_tier,
            });
        }
    }

    return facts;
}

function scoreCoverage({ facts = [], sources = [] }) {
    const extractableSources = sources.filter(source => source.can_extract_facts).length;
    const metadataOnlySources = sources.filter(source => source.access_mode === 'metadata_only').length;

    let coverage_level = 'low';
    if (facts.length >= MIN_HIGH_COVERAGE_FACTS && extractableSources >= 2) {
        coverage_level = 'high';
    } else if (facts.length >= MIN_MEDIUM_COVERAGE_FACTS) {
        coverage_level = 'medium';
    }

    return {
        coverage_level,
        fact_count: facts.length,
        trusted_source_count: extractableSources,
        metadata_only_source_count: metadataOnlySources,
        can_generate_quiz: facts.length >= MIN_MEDIUM_COVERAGE_FACTS,
        can_generate_map: facts.length > 0,
        warning: facts.length >= MIN_MEDIUM_COVERAGE_FACTS
            ? null
            : 'Limited reliable source coverage. Practice is exploratory unless the learner provides source material.',
    };
}

function buildGroundingPromptSection({ facts = [], coverage }) {
    if (!facts.length) {
        return `
### SOURCE COVERAGE
Coverage level: low
No source-backed atomic facts were available for this node. You may create exploratory practice only for broad, well-known foundational concepts. Mark every scenario with confidence "low", validation_status "ungrounded_exploratory", and source_fact_ids [].
`;
    }

    return `
### SOURCE-BACKED FACTS
Coverage level: ${coverage.coverage_level}
Use these facts as factual authority for domain-specific claims. Every factual practice question should cite one or more source_fact_ids.
${facts.map(fact => `- ${fact.fact_id}: ${fact.claim} [source: ${fact.source_title}]`).join('\n')}
`;
}

function buildSourceManifestPromptSection({ sources = [] }) {
    if (!sources.length) {
        return `
### SOURCE DISCOVERY MANIFEST
No external source candidates were discovered for this scope. Use broad curriculum knowledge for sequencing, but do not invent citations or claim a specific source supports a domain fact.
`;
    }

    const rows = sources.slice(0, MAX_SOURCE_MANIFEST_ITEMS).map(source => {
        const access = source.access_mode || 'metadata_only';
        const role = source.source_role || 'recommended_resource';
        const title = source.title || source.domain || source.id;
        const url = source.url ? ` (${source.url})` : '';
        return `- ${source.id}: ${title}${url}; role=${role}; access=${access}; extractable_facts=${source.can_extract_facts ? 'yes' : 'no'}; note=${source.reason || 'n/a'}`;
    });

    return `
### SOURCE DISCOVERY MANIFEST
These are candidate sources/resources discovered or uploaded for this scope.
Rules:
- Use full-text uploaded sources as factual authority when relevant.
- Use metadata-only web/video/book resources only as recommendations or reading/watch tasks.
- Do not create factual quiz claims from metadata-only resources.
- If the learner's topic is broader than the available source material, use general curriculum design for the map and mark source coverage low or medium as appropriate.
${rows.join('\n')}
`;
}

function validatePracticeJson(practiceJson, grounding) {
    const factIds = new Set((grounding.facts || []).map(fact => fact.fact_id));
    const coverage = grounding.coverage || scoreCoverage({ facts: [], sources: [] });

    const scenarios = (practiceJson.scenarios || []).map((scenario) => {
        const citedIds = (scenario.source_fact_ids || []).filter(id => factIds.has(id));
        const hasFacts = factIds.size > 0;
        const isGrounded = citedIds.length > 0;

        let confidence = scenario.confidence || 'low';
        let validation_status = scenario.validation_status || 'ungrounded_exploratory';

        if (isGrounded) {
            confidence = scenario.confidence || (coverage.coverage_level === 'high' ? 'high' : 'medium');
            validation_status = 'source_supported';
        } else if (hasFacts) {
            confidence = 'low';
            validation_status = 'needs_source_review';
        }

        return {
            ...scenario,
            source_fact_ids: citedIds,
            confidence,
            validation_status,
        };
    });

    return {
        ...practiceJson,
        scenarios,
        grounding_summary: coverage,
        source_facts: grounding.facts || [],
        source_candidates: (grounding.sources || []).map(({ content, ...source }) => source),
    };
}

function validateMapJson(mapJson, grounding) {
    const factIds = new Set((grounding.facts || []).map(fact => fact.fact_id));
    const coverage = grounding.coverage || scoreCoverage({ facts: [], sources: [] });

    const nodes = (mapJson.nodes || []).map(node => {
        const citedIds = (node.source_fact_ids || []).filter(id => factIds.has(id));
        const isGrounded = citedIds.length > 0;

        return {
            ...node,
            source_fact_ids: citedIds,
            confidence: isGrounded ? (node.confidence || (coverage.coverage_level === 'high' ? 'high' : 'medium')) : 'low',
            coverage_score: isGrounded ? coverage.coverage_level : 'low',
        };
    });

    return {
        ...mapJson,
        nodes,
        source_coverage: coverage,
        source_facts: grounding.facts || [],
        source_candidates: (grounding.sources || []).map(({ content, ...source }) => source),
    };
}

function validateQuizJson(quizJson, grounding) {
    const factIds = new Set((grounding.facts || []).map(fact => fact.fact_id));
    const coverage = grounding.coverage || scoreCoverage({ facts: [], sources: [] });

    const levels = (quizJson.levels || []).map(level => {
        const citedIds = (level.source_fact_ids || []).filter(id => factIds.has(id));
        const isGrounded = citedIds.length > 0;

        return {
            ...level,
            source_fact_ids: citedIds,
            confidence: isGrounded ? (level.confidence || (coverage.coverage_level === 'high' ? 'high' : 'medium')) : 'low',
            validation_status: isGrounded ? 'source_supported' : (factIds.size > 0 ? 'needs_source_review' : 'ungrounded_exploratory'),
        };
    });

    return {
        ...quizJson,
        levels,
        grounding_summary: coverage,
        source_facts: grounding.facts || [],
        source_candidates: (grounding.sources || []).map(({ content, ...source }) => source),
    };
}

function buildGroundingContext({ topic, nodeLabel, keyConcepts = [], sourceMaterials = [], contextMaterials = [], articles = [] }) {
    const sources = buildSourceCandidates({ sourceMaterials, contextMaterials, articles });
    const facts = compileFacts({ topic, nodeLabel, keyConcepts, sources });
    const coverage = scoreCoverage({ facts, sources });

    return {
        sources,
        facts,
        coverage,
        promptSection: buildGroundingPromptSection({ facts, coverage }),
        sourceManifestSection: buildSourceManifestPromptSection({ sources }),
    };
}

module.exports = {
    buildSourceManifestPromptSection,
    buildGroundingContext,
    buildSourceCandidates,
    classifyAccess,
    compileFacts,
    scoreCoverage,
    scoreSourceTrust,
    validateMapJson,
    validatePracticeJson,
    validateQuizJson,
};
