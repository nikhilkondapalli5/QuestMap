import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';

const STATUS_COLORS = {
    completed: { bg: '#059669', border: '#34d399', text: '#ecfdf5', glow: 'rgba(52,211,153,0.3)' },
    in_progress: { bg: '#2563eb', border: '#60a5fa', text: '#eff6ff', glow: 'rgba(96,165,250,0.3)' },
    recommended_next: { bg: '#7c3aed', border: '#a78bfa', text: '#f5f3ff', glow: 'rgba(167,139,250,0.4)' },
    not_started: { bg: '#374151', border: '#6b7280', text: '#f3f4f6', glow: 'rgba(107,114,128,0.15)' },
};

const BLOOM_ICONS = {
    'Remember': '📝',
    'Understand': '💡',
    'Apply': '🛠️',
    'Analyze': '🔍',
    'Evaluate': '⚖️',
    'Create': '🚀',
};

function layoutNodes(nodes, width, height) {
    const count = nodes.length;
    const centerX = width / 2;
    const centerY = height / 2;
    const positions = [];

    if (count <= 3) {
        const spacing = width / (count + 1);
        nodes.forEach((_, i) => {
            positions.push({ x: spacing * (i + 1), y: centerY });
        });
    } else {
        // Multi-row layout with gentle curve
        const cols = Math.ceil(Math.sqrt(count * 1.5));
        const rows = Math.ceil(count / cols);
        const spacingX = Math.min(220, (width - 100) / cols);
        const spacingY = Math.min(160, (height - 60) / rows);
        const startX = centerX - ((cols - 1) * spacingX) / 2;
        const startY = centerY - ((rows - 1) * spacingY) / 2;

        nodes.forEach((_, i) => {
            const row = Math.floor(i / cols);
            const col = i % cols;
            const offset = row % 2 === 1 ? spacingX * 0.3 : 0;
            positions.push({
                x: startX + col * spacingX + offset,
                y: startY + row * spacingY,
            });
        });
    }
    return positions;
}

function drawArrow(ctx, fromX, fromY, toX, toY, relationship) {
    const headLen = 10;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const angle = Math.atan2(dy, dx);
    // Shorten by node radius
    const nodeR = 50;
    const startX = fromX + Math.cos(angle) * nodeR;
    const startY = fromY + Math.sin(angle) * nodeR;
    const endX = toX - Math.cos(angle) * (nodeR + 6);
    const endY = toY - Math.sin(angle) * (nodeR + 6);

    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);

    if (relationship === 'optional') {
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(107,114,128,0.4)';
    } else if (relationship === 'recommended') {
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(167,139,250,0.5)';
    } else {
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(96,165,250,0.4)';
    }
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - headLen * Math.cos(angle - Math.PI / 6), endY - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(endX - headLen * Math.cos(angle + Math.PI / 6), endY - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
}

const KnowledgeMap = ({ mapData, selectedNode, onNodeSelect }) => {
    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const [hoveredNode, setHoveredNode] = useState(null);
    const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
    const positions = useMemo(
        () => (mapData?.nodes ? layoutNodes(mapData.nodes, dimensions.width, dimensions.height) : []),
        [mapData, dimensions]
    );

    // Observe container size
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const obs = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;
            setDimensions({ width: Math.max(width, 400), height: Math.max(height, 300) });
        });
        obs.observe(container);
        return () => obs.disconnect();
    }, []);

    // Draw
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !mapData?.nodes || positions.length === 0) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = dimensions.width * dpr;
        canvas.height = dimensions.height * dpr;
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, dimensions.width, dimensions.height);

        // Draw edges
        (mapData.edges || []).forEach(edge => {
            const srcIdx = mapData.nodes.findIndex(n => n.id === edge.source);
            const tgtIdx = mapData.nodes.findIndex(n => n.id === edge.target);
            if (srcIdx === -1 || tgtIdx === -1) return;
            drawArrow(ctx, positions[srcIdx].x, positions[srcIdx].y, positions[tgtIdx].x, positions[tgtIdx].y, edge.relationship);
        });

        // Draw nodes
        mapData.nodes.forEach((node, i) => {
            const pos = positions[i];
            const colors = STATUS_COLORS[node.status] || STATUS_COLORS.not_started;
            const isSelected = selectedNode?.id === node.id;
            const isHovered = hoveredNode === i;
            const radius = isSelected ? 54 : isHovered ? 52 : 48;

            // Glow
            if (isSelected || isHovered || node.status === 'recommended_next') {
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, radius + 8, 0, Math.PI * 2);
                ctx.fillStyle = colors.glow;
                ctx.fill();
            }

            // Circle
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
            const grad = ctx.createRadialGradient(pos.x - 10, pos.y - 10, 5, pos.x, pos.y, radius);
            grad.addColorStop(0, colors.border);
            grad.addColorStop(1, colors.bg);
            ctx.fillStyle = grad;
            ctx.fill();
            ctx.strokeStyle = isSelected ? '#fff' : colors.border;
            ctx.lineWidth = isSelected ? 3 : 1.5;
            ctx.stroke();

            // Bloom icon
            const icon = BLOOM_ICONS[node.bloom_level] || '📘';
            ctx.font = '16px serif';
            ctx.textAlign = 'center';
            ctx.fillText(icon, pos.x, pos.y - 8);

            // Label
            ctx.font = `${isSelected ? 'bold ' : ''}11px Inter, system-ui, sans-serif`;
            ctx.fillStyle = colors.text;
            ctx.textAlign = 'center';
            const label = node.label.length > 18 ? node.label.slice(0, 16) + '…' : node.label;
            ctx.fillText(label, pos.x, pos.y + 10);

            // Hours badge
            if (node.estimated_hours) {
                ctx.font = '9px Inter, system-ui, sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.6)';
                ctx.fillText(`${node.estimated_hours}h`, pos.x, pos.y + 24);
            }
        });
    }, [mapData, positions, selectedNode, hoveredNode, dimensions]);

    const handleCanvasEvent = useCallback((e, click = false) => {
        if (!positions.length || !mapData?.nodes) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        let found = -1;
        positions.forEach((pos, i) => {
            const dx = mx - pos.x;
            const dy = my - pos.y;
            if (dx * dx + dy * dy < 55 * 55) found = i;
        });

        if (click && found >= 0) {
            onNodeSelect?.(mapData.nodes[found]);
        }
        setHoveredNode(found >= 0 ? found : null);
        canvasRef.current.style.cursor = found >= 0 ? 'pointer' : 'default';
    }, [positions, mapData, onNodeSelect]);

    if (!mapData?.nodes?.length) {
        return (
            <div className="flex items-center justify-center h-full text-gray-500 italic">
                Generate a knowledge map to see it here
            </div>
        );
    }

    return (
        <div ref={containerRef} className="w-full h-full relative">
            <canvas
                ref={canvasRef}
                style={{ width: '100%', height: '100%' }}
                onClick={e => handleCanvasEvent(e, true)}
                onMouseMove={e => handleCanvasEvent(e, false)}
            />
            {/* Legend */}
            <div className="absolute bottom-3 left-3 flex gap-3 text-[10px] text-gray-400">
                {Object.entries(STATUS_COLORS).map(([key, val]) => (
                    <span key={key} className="flex items-center gap-1">
                        <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: val.border }} />
                        {key.replace('_', ' ')}
                    </span>
                ))}
            </div>
        </div>
    );
};

export default KnowledgeMap;
