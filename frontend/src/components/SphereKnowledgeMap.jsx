import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from "../lib/utils";

const STATUS_COLORS = {
    completed: { bg: '#059669', border: '#34d399', text: '#ecfdf5', glow: 'rgba(52,211,153,0.3)', secondary: '#10b981' },
    in_progress: { bg: '#2563eb', border: '#60a5fa', text: '#eff6ff', glow: 'rgba(96,165,250,0.3)', secondary: '#3b82f6' },
    recommended_next: { bg: '#7c3aed', border: '#a78bfa', text: '#f5f3ff', glow: 'rgba(167,139,250,0.4)', secondary: '#8b5cf6' },
    not_started: { bg: '#1f2937', border: '#4b5563', text: '#9ca3af', glow: 'rgba(107,114,128,0.1)', secondary: '#374151' },
};

const BLOOM_ICONS = {
    'Remember': '📝',
    'Understand': '💡',
    'Apply': '🛠️',
    'Analyze': '🔍',
    'Evaluate': '⚖️',
    'Create': '🚀',
};

const SPHERE_MATH = {
    degreesToRadians: (degrees) => degrees * (Math.PI / 180),
    normalizeAngle: (angle) => {
        while (angle > 180) angle -= 360;
        while (angle < -180) angle += 360;
        return angle;
    }
};

const SphereKnowledgeMap = ({
    mapData,
    selectedNode,
    onNodeSelect,
    containerSize = 600,
    sphereRadius = 240,
    dragSensitivity = 0.5,
    momentumDecay = 0.95,
    maxRotationSpeed = 3,
    autoRotate = true,
    autoRotateSpeed = 0.2,
}) => {
    const [rotation, setRotation] = useState({ x: 15, y: 15 });
    const [velocity, setVelocity] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [hoveredIndex, setHoveredIndex] = useState(null);

    const containerRef = useRef(null);
    const lastMousePos = useRef({ x: 0, y: 0 });
    const animationFrame = useRef(null);

    const nodePositions = useMemo(() => {
        if (!mapData?.nodes) return [];
        const count = mapData.nodes.length;
        const positions = [];
        const goldenRatio = (1 + Math.sqrt(5)) / 2;
        const angleIncrement = 2 * Math.PI / goldenRatio;

        for (let i = 0; i < count; i++) {
            const t = i / count;
            const inclination = Math.acos(1 - 2 * t);
            const azimuth = angleIncrement * i;

            let phi = inclination * (180 / Math.PI);
            let theta = (azimuth * (180 / Math.PI)) % 360;

            // Better vertical range for poles
            phi = 20 + (phi / 180) * 140;

            positions.push({ theta, phi, radius: sphereRadius });
        }
        return positions;
    }, [mapData, sphereRadius]);

    const calculateWorldPositions = useCallback(() => {
        return nodePositions.map((pos) => {
            const thetaRad = SPHERE_MATH.degreesToRadians(pos.theta);
            const phiRad = SPHERE_MATH.degreesToRadians(pos.phi);
            const rotXRad = SPHERE_MATH.degreesToRadians(rotation.x);
            const rotYRad = SPHERE_MATH.degreesToRadians(rotation.y);

            let x = pos.radius * Math.sin(phiRad) * Math.cos(thetaRad);
            let y = pos.radius * Math.cos(phiRad);
            let z = pos.radius * Math.sin(phiRad) * Math.sin(thetaRad);

            // Y-axis rotation
            const x1 = x * Math.cos(rotYRad) + z * Math.sin(rotYRad);
            const z1 = -x * Math.sin(rotYRad) + z * Math.cos(rotYRad);
            x = x1; z = z1;

            // X-axis rotation
            const y2 = y * Math.cos(rotXRad) - z * Math.sin(rotXRad);
            const z2 = y * Math.sin(rotXRad) + z * Math.cos(rotXRad);
            y = y2; z = z2;

            const fadeZoneStart = -10;
            const fadeZoneEnd = -180;
            const isVisible = z > fadeZoneEnd;
            const fadeOpacity = z <= fadeZoneStart
                ? Math.max(0.1, (z - fadeZoneEnd) / (fadeZoneStart - fadeZoneEnd))
                : 1;

            // Depth scaling
            const depthScale = (z + sphereRadius) / (2 * sphereRadius);
            const scale = 0.7 + depthScale * 0.4;

            return {
                x, y, z, scale, isVisible, fadeOpacity,
                zIndex: Math.round(1000 + z)
            };
        });
    }, [nodePositions, rotation, sphereRadius]);

    const updatePhysics = useCallback(() => {
        if (isDragging) return;

        setVelocity(prev => ({
            x: prev.x * momentumDecay,
            y: prev.y * momentumDecay
        }));

        setRotation(prev => {
            let newY = prev.y + (autoRotate ? autoRotateSpeed : 0) + (velocity.y * 0.1);
            let newX = prev.x + (velocity.x * 0.1);
            return {
                x: SPHERE_MATH.normalizeAngle(newX),
                y: SPHERE_MATH.normalizeAngle(newY)
            };
        });
    }, [isDragging, momentumDecay, velocity, autoRotate, autoRotateSpeed]);

    useEffect(() => {
        const animate = () => {
            updatePhysics();
            animationFrame.current = requestAnimationFrame(animate);
        };
        animationFrame.current = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(animationFrame.current);
    }, [updatePhysics]);

    const handlePointerDown = (e) => {
        setIsDragging(true);
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    };

    const handlePointerMove = useCallback((e) => {
        if (!isDragging) return;
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;

        const clampSpeed = (value) => Math.max(-maxRotationSpeed, Math.min(maxRotationSpeed, value));
        const rx = clampSpeed(-dy * dragSensitivity);
        const ry = clampSpeed(dx * dragSensitivity);

        setRotation(prev => ({
            x: SPHERE_MATH.normalizeAngle(prev.x + rx),
            y: SPHERE_MATH.normalizeAngle(prev.y + ry)
        }));
        setVelocity({ x: rx, y: ry });
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    }, [dragSensitivity, isDragging, maxRotationSpeed]);

    const handlePointerUp = useCallback(() => setIsDragging(false), []);

    useEffect(() => {
        window.addEventListener('pointermove', handlePointerMove);
        window.addEventListener('pointerup', handlePointerUp);
        return () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
        };
    }, [handlePointerMove, handlePointerUp]);

    const worldPositions = calculateWorldPositions();

    return (
        <div
            ref={containerRef}
            className="relative w-full h-full cursor-grab active:cursor-grabbing select-none"
            onPointerDown={handlePointerDown}
            style={{ perspective: '1200px' }}
        >
            <div className="absolute inset-0 flex items-center justify-center">
                {/* Connection Lines (Edges) */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none overflow-visible">
                    {mapData?.edges?.map((edge, i) => {
                        const startIdx = mapData.nodes.findIndex(n => n.id === edge.from);
                        const endIdx = mapData.nodes.findIndex(n => n.id === edge.to);

                        const start = worldPositions[startIdx];
                        const end = worldPositions[endIdx];

                        if (!start || !end || !start.isVisible || !end.isVisible) return null;

                        // Calculate midpoint Z for depth-aware line opacity
                        const midZ = (start.z + end.z) / 2;
                        const lineOpacity = midZ <= -10
                            ? Math.max(0.05, (midZ + 180) / 170 * 0.4)
                            : 0.4;

                        return (
                            <line
                                key={`edge-${i}`}
                                x1={containerSize / 2 + start.x}
                                y1={containerSize / 2 + start.y}
                                x2={containerSize / 2 + end.x}
                                y2={containerSize / 2 + end.y}
                                stroke="white"
                                strokeWidth="1"
                                strokeOpacity={lineOpacity}
                                style={{ transition: 'all 0.3s ease-out' }}
                            />
                        );
                    })}
                </svg>

                {mapData?.nodes?.map((node, i) => {
                    const pos = worldPositions[i];
                    if (!pos || !pos.isVisible) return null;

                    const colors = STATUS_COLORS[node.status] || STATUS_COLORS.not_started;
                    const isSelected = selectedNode?.id === node.id;
                    const isHovered = hoveredIndex === i;
                    const finalScale = isSelected ? pos.scale * 1.3 : isHovered ? pos.scale * 1.2 : pos.scale;

                    return (
                        <motion.div
                            key={node.id}
                            className="absolute"
                            initial={false}
                            animate={{
                                x: pos.x,
                                y: pos.y,
                                scale: finalScale,
                                opacity: pos.fadeOpacity,
                            }}
                            transition={{ type: 'spring', damping: 25, stiffness: 120, mass: 0.5 }}
                            style={{
                                zIndex: pos.zIndex,
                            }}
                            onMouseEnter={() => setHoveredIndex(i)}
                            onMouseLeave={() => setHoveredIndex(null)}
                            onClick={() => onNodeSelect(node)}
                        >
                            <div
                                className={cn(
                                    "relative group flex flex-col items-center justify-center text-center transition-all duration-300",
                                    isSelected ? "scale-110" : ""
                                )}
                                style={{ width: '100px', height: '100px' }}
                            >
                                {/* Node Bubble */}
                                <div
                                    className="w-16 h-16 rounded-full border-2 flex items-center justify-center mb-2 shadow-2xl transition-all duration-500 relative"
                                    style={{
                                        backgroundColor: colors.bg,
                                        borderColor: isSelected ? '#fff' : colors.border,
                                        boxShadow: (isSelected || isHovered) ? `0 0 30px ${colors.secondary}` : 'none'
                                    }}
                                >
                                    {/* Inner Glow */}
                                    <div className="absolute inset-0 rounded-full opacity-30 blur-md pointer-events-none" style={{ backgroundColor: colors.secondary }} />

                                    <span className="text-xl relative z-10">{BLOOM_ICONS[node.bloom_level] || '📘'}</span>
                                </div>

                                {/* Label */}
                                <div className="max-w-[120px]">
                                    <p className={cn(
                                        "text-[10px] font-bold tracking-tight mb-0.5 transition-colors",
                                        isSelected ? "text-white" : "text-gray-400 group-hover:text-gray-200"
                                    )}>
                                        {node.label}
                                    </p>
                                    {node.estimated_hours && (
                                        <p className="text-[8px] text-gray-500 font-medium">{node.estimated_hours}h est.</p>
                                    )}
                                </div>

                                {/* Status Indicator */}
                                {node.status === 'recommended_next' && !isSelected && (
                                    <div className="absolute -top-1 -right-1">
                                        <div className="w-2 h-2 bg-purple-500 rounded-full animate-ping absolute" />
                                        <div className="w-2 h-2 bg-purple-500 rounded-full relative" />
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    );
                })}
            </div>
        </div>
    );
};

export default SphereKnowledgeMap;
