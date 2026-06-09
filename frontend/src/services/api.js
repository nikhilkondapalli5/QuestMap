import { API_BASE } from '../config/api';

export const getMapData = async (topic, skillLevel) => {
    try {
        const response = await fetch(`${API_BASE}/generate-map`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic, skill_level: skillLevel })
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error("getMapData failed:", error);
        return { nodes: [], links: [] };
    }
};

export const getRecommendations = async (topic) => {
    try {
        const response = await fetch(`${API_BASE}/generate-recommendations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ topic })
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        console.error("getRecommendations failed:", error);
        return [];
    }
};

export const getPracticeData = async (node) => {
    try {
        const response = await fetch(`${API_BASE}/generate-node-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(node)
        });
        const data = await response.json();
        return data.practice;
    } catch (error) {
        console.error("getPracticeData failed:", error);
        return null;
    }
};

export const getResourceData = async (node) => {
    try {
        const response = await fetch(`${API_BASE}/generate-node-data`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(node)
        });
        const data = await response.json();
        return data.resources;
    } catch (error) {
        console.error("getResourceData failed:", error);
        return null;
    }
};
