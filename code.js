// code.js — Line Length Measurer v7
// Persistence: scale + tracked lines saved to document via setPluginData
// Scale hierarchy: frame/group scale > document global scale

figma.showUI(__html__, {
	width: 280,
	height: 600,
	title: "Line Length Measurer",
	themeColors: true,
});

// ── Color palettes ────────────────────────────────────────────────────────────
var PALETTES = {
	dark: [
		"#E63946",
		"#2196F3",
		"#4CAF50",
		"#FF9800",
		"#9C27B0",
		"#00BCD4",
		"#FFEB3B",
		"#F06292",
		"#8BC34A",
		"#FF5722",
	],
	light: [
		"#C62828",
		"#1565C0",
		"#2E7D32",
		"#E65100",
		"#6A1B9A",
		"#00838F",
		"#F9A825",
		"#AD1457",
		"#558B2F",
		"#BF360C",
	],
};

var lineColorIndex = 0;
var measuredLines = {}; // runtime cache: nodeId -> entry
var suppressedChangeIds = {};
var pendingRestoreData = null;
var elevationVisualsGeneration = 0;
var elevationVisualsSyncChain = Promise.resolve();
var elevationSyncInProgress = false;
var elevationSyncDebounceTimer = null;
var elevationFontLoaded = false;
var ELEVATION_SYNC_DEBOUNCE_MS = 250;
var DEFAULT_UI_SETTINGS = {
	colorMode: "auto-dark",
	lineColor: "#ff5500",
	labelColor: "#ff5500",
	fontSize: 14,
	labelPlacement: "above",
	lineWidth: 8,
	showPointMarkers: true,
	elevationDisplayAtPoints: true,
	showHeightBadges: false,
	showDiffBadges: true,
	showSlopeBadges: true,
};

function readBoolSetting(parsed, key, defaultValue) {
	if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, key)) return defaultValue;
	return !!parsed[key];
}

function saveBoolSetting(value, defaultValue) {
	return typeof value === "boolean" ? value : defaultValue;
}

function readUiSettings() {
	var raw = figma.root.getPluginData("uiSettings");
	if (!raw) return DEFAULT_UI_SETTINGS;
	try {
		var parsed = JSON.parse(raw);
		return {
			colorMode:
				parsed.colorMode === "auto-dark" || parsed.colorMode === "auto-light" || parsed.colorMode === "manual"
					? parsed.colorMode
					: DEFAULT_UI_SETTINGS.colorMode,
			lineColor:
				typeof parsed.lineColor === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.lineColor)
					? parsed.lineColor
					: DEFAULT_UI_SETTINGS.lineColor,
			labelColor:
				typeof parsed.labelColor === "string" && /^#[0-9a-fA-F]{6}$/.test(parsed.labelColor)
					? parsed.labelColor
					: DEFAULT_UI_SETTINGS.labelColor,
			fontSize: Math.max(8, Math.min(96, parseInt(parsed.fontSize) || DEFAULT_UI_SETTINGS.fontSize)),
			labelPlacement:
				parsed.labelPlacement === "above" ||
				parsed.labelPlacement === "center" ||
				parsed.labelPlacement === "below"
					? parsed.labelPlacement
					: DEFAULT_UI_SETTINGS.labelPlacement,
			lineWidth: Math.max(1, Math.min(64, parseFloat(parsed.lineWidth) || DEFAULT_UI_SETTINGS.lineWidth)),
			showPointMarkers: readBoolSetting(parsed, "showPointMarkers", DEFAULT_UI_SETTINGS.showPointMarkers),
			elevationDisplayAtPoints: readBoolSetting(
				parsed,
				"elevationDisplayAtPoints",
				DEFAULT_UI_SETTINGS.elevationDisplayAtPoints,
			),
			showHeightBadges: readBoolSetting(parsed, "showHeightBadges", DEFAULT_UI_SETTINGS.showHeightBadges),
			showDiffBadges: readBoolSetting(parsed, "showDiffBadges", DEFAULT_UI_SETTINGS.showDiffBadges),
			showSlopeBadges: readBoolSetting(parsed, "showSlopeBadges", DEFAULT_UI_SETTINGS.showSlopeBadges),
		};
	} catch (e) {
		return DEFAULT_UI_SETTINGS;
	}
}

function saveUiSettings(settings) {
	var safe = {
		colorMode:
			settings.colorMode === "auto-dark" || settings.colorMode === "auto-light" || settings.colorMode === "manual"
				? settings.colorMode
				: DEFAULT_UI_SETTINGS.colorMode,
		lineColor:
			typeof settings.lineColor === "string" && /^#[0-9a-fA-F]{6}$/.test(settings.lineColor)
				? settings.lineColor
				: DEFAULT_UI_SETTINGS.lineColor,
		labelColor:
			typeof settings.labelColor === "string" && /^#[0-9a-fA-F]{6}$/.test(settings.labelColor)
				? settings.labelColor
				: DEFAULT_UI_SETTINGS.labelColor,
		fontSize: Math.max(8, Math.min(96, parseInt(settings.fontSize) || DEFAULT_UI_SETTINGS.fontSize)),
		labelPlacement:
			settings.labelPlacement === "above" ||
			settings.labelPlacement === "center" ||
			settings.labelPlacement === "below"
				? settings.labelPlacement
				: DEFAULT_UI_SETTINGS.labelPlacement,
		lineWidth: Math.max(1, Math.min(64, parseFloat(settings.lineWidth) || DEFAULT_UI_SETTINGS.lineWidth)),
		showPointMarkers: saveBoolSetting(settings.showPointMarkers, DEFAULT_UI_SETTINGS.showPointMarkers),
		elevationDisplayAtPoints: saveBoolSetting(
			settings.elevationDisplayAtPoints,
			DEFAULT_UI_SETTINGS.elevationDisplayAtPoints,
		),
		showHeightBadges: saveBoolSetting(settings.showHeightBadges, DEFAULT_UI_SETTINGS.showHeightBadges),
		showDiffBadges: saveBoolSetting(settings.showDiffBadges, DEFAULT_UI_SETTINGS.showDiffBadges),
		showSlopeBadges: saveBoolSetting(settings.showSlopeBadges, DEFAULT_UI_SETTINGS.showSlopeBadges),
	};
	figma.root.setPluginData("uiSettings", JSON.stringify(safe));
}

function ensureEntryDefaults(entry) {
	if (!entry || typeof entry !== "object") return entry;
	if (!entry.elevationsCmByPointIndex || typeof entry.elevationsCmByPointIndex !== "object") {
		entry.elevationsCmByPointIndex = {};
	}
	if (!entry.pointHeightsByPointIndex || typeof entry.pointHeightsByPointIndex !== "object") {
		entry.pointHeightsByPointIndex = {};
	}
	if (!Array.isArray(entry.pointMarkerIds)) entry.pointMarkerIds = [];
	if (!Array.isArray(entry.heightBadgeIds)) entry.heightBadgeIds = [];
	if (!Array.isArray(entry.slopeBadgeIds)) entry.slopeBadgeIds = [];
	return entry;
}

function attachUiPrefsToEntry(entry) {
	if (!entry) return entry;
	var s = readUiSettings();
	entry.uiPrefs = {
		colorMode: s.colorMode,
		lineColor: s.lineColor,
		labelColor: s.labelColor,
		fontSize: s.fontSize,
		labelPlacement: s.labelPlacement,
		lineWidth: s.lineWidth,
		showPointMarkers: s.showPointMarkers,
		elevationDisplayAtPoints: s.elevationDisplayAtPoints,
		showHeightBadges: s.showHeightBadges,
		showDiffBadges: s.showDiffBadges,
		showSlopeBadges: s.showSlopeBadges,
	};
	return entry;
}

function uiSettingsFromLineEntry(entry) {
	if (!entry) return null;
	var p = entry.uiPrefs;
	if (!p || typeof p !== "object") return null;
	return {
		colorMode:
			p.colorMode === "auto-dark" || p.colorMode === "auto-light" || p.colorMode === "manual"
				? p.colorMode
				: entry.lineColor
					? DEFAULT_UI_SETTINGS.colorMode
					: DEFAULT_UI_SETTINGS.colorMode,
		lineColor:
			typeof p.lineColor === "string" && /^#[0-9a-fA-F]{6}$/.test(p.lineColor)
				? p.lineColor
				: typeof entry.lineColor === "string"
					? entry.lineColor
					: DEFAULT_UI_SETTINGS.lineColor,
		labelColor:
			typeof p.labelColor === "string" && /^#[0-9a-fA-F]{6}$/.test(p.labelColor)
				? p.labelColor
				: typeof entry.labelColor === "string"
					? entry.labelColor
					: DEFAULT_UI_SETTINGS.labelColor,
		fontSize: Math.max(8, Math.min(96, parseInt(p.fontSize) || entry.fontSize || DEFAULT_UI_SETTINGS.fontSize)),
		labelPlacement:
			p.labelPlacement === "above" || p.labelPlacement === "center" || p.labelPlacement === "below"
				? p.labelPlacement
				: entry.labelPlacement || DEFAULT_UI_SETTINGS.labelPlacement,
		lineWidth: Math.max(
			1,
			Math.min(64, parseFloat(p.lineWidth) || entry.lineWidth || DEFAULT_UI_SETTINGS.lineWidth),
		),
		showPointMarkers: readBoolSetting(p, "showPointMarkers", DEFAULT_UI_SETTINGS.showPointMarkers),
		elevationDisplayAtPoints: readBoolSetting(
			p,
			"elevationDisplayAtPoints",
			DEFAULT_UI_SETTINGS.elevationDisplayAtPoints,
		),
		showHeightBadges: readBoolSetting(p, "showHeightBadges", DEFAULT_UI_SETTINGS.showHeightBadges),
		showDiffBadges: readBoolSetting(p, "showDiffBadges", DEFAULT_UI_SETTINGS.showDiffBadges),
		showSlopeBadges: readBoolSetting(p, "showSlopeBadges", DEFAULT_UI_SETTINGS.showSlopeBadges),
	};
}

function suppressNodeChanges(ids) {
	if (!ids) return;
	var arr = Array.isArray(ids) ? ids : [ids];
	for (var i = 0; i < arr.length; i++) {
		if (arr[i]) suppressedChangeIds[arr[i]] = true;
	}
}

function unsuppressNodeChanges(ids) {
	if (!ids) return;
	var arr = Array.isArray(ids) ? ids : [ids];
	for (var i = 0; i < arr.length; i++) {
		if (arr[i]) delete suppressedChangeIds[arr[i]];
	}
}

function isNodeChangeSuppressed(id) {
	return !!suppressedChangeIds[id];
}

// ── Startup: restore state from document ─────────────────────────────────────

var PLUGIN_LINE_ENTRY = "lineEntry";
var PLUGIN_LINE_VECTOR_ID = "pluginLineVectorId";

function getNodePage(node) {
	var cur = node;
	while (cur && cur.type !== "PAGE") cur = cur.parent;
	return cur;
}

function getNodeCenterInParent(node) {
	if (!node || !("x" in node)) return null;
	return { x: node.x + (node.width || 0) / 2, y: node.y + (node.height || 0) / 2 };
}

async function nodeExists(id) {
	if (!id) return false;
	try {
		var n = await figma.getNodeByIdAsync(id);
		return !!n;
	} catch (e) {
		return false;
	}
}

function findLabelsInContainer(container) {
	if (!container || typeof container.findAll !== "function") return [];
	return container.findAll(function (n) {
		return n.getPluginData && n.getPluginData("pluginLabel") === "1";
	});
}

function pickClosestVector(vectors, refNode) {
	if (!vectors || vectors.length === 0) return null;
	if (vectors.length === 1) return vectors[0];
	var rc = getNodeCenterInParent(refNode);
	if (!rc) return vectors[0];
	var best = vectors[0];
	var bestD = Number.POSITIVE_INFINITY;
	for (var vi = 0; vi < vectors.length; vi++) {
		var vc = getNodeCenterInParent(vectors[vi]);
		if (!vc) continue;
		var dx = vc.x - rc.x;
		var dy = vc.y - rc.y;
		var d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = vectors[vi];
		}
	}
	return best;
}

function listMeasuredPathVectorsInContainer(container) {
	var out = [];
	if (!container || !container.children) return out;
	for (var i = 0; i < container.children.length; i++) {
		if (isMeasuredPathVector(container.children[i])) out.push(container.children[i]);
	}
	return out;
}

function pickClosestLabel(labels, vector) {
	if (!labels || labels.length === 0) return null;
	if (labels.length === 1) return labels[0];
	var vc = getNodeCenterInParent(vector);
	if (!vc) return labels[0];
	var best = labels[0];
	var bestD = Number.POSITIVE_INFINITY;
	for (var i = 0; i < labels.length; i++) {
		var lc = getNodeCenterInParent(labels[i]);
		if (!lc) continue;
		var dx = lc.x - vc.x;
		var dy = lc.y - vc.y;
		var d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = labels[i];
		}
	}
	return best;
}

async function findLabelForVector(vector) {
	var parent = vector.parent;
	if (parent) {
		var inParent = pickClosestLabel(findLabelsInContainer(parent), vector);
		if (inParent) return inParent;
	}
	var page = getNodePage(vector);
	if (page) {
		var linked = page.findAll(function (n) {
			return n.getPluginData && n.getPluginData(PLUGIN_LINE_VECTOR_ID) === vector.id;
		});
		if (linked.length > 0) return linked[0];
	}
	return null;
}

function parseLineEntryJson(raw) {
	if (!raw) return null;
	try {
		var entry = JSON.parse(raw);
		ensureEntryDefaults(entry);
		return entry;
	} catch (e) {
		return null;
	}
}

function getPluginLineGroupForVector(vector) {
	var parent = vector && vector.parent;
	if (parent && parent.getPluginData && parent.getPluginData("pluginGroup") === "1") return parent;
	return null;
}

function isPluginElevationNode(n) {
	if (!n || !n.getPluginData) return false;
	if (n.getPluginData("pluginElevationPoint") === "1") return true;
	if (n.getPluginData("pluginElevationPointInfo") === "1") return true;
	if (n.getPluginData("pluginElevationMarker") === "1") return true;
	if (n.getPluginData("pluginElevationBadgeType")) return true;
	return false;
}

function isMeasuredPathVector(n) {
	if (!n || n.type !== "VECTOR" || isPluginElevationNode(n)) return false;
	var vn = n.vectorNetwork;
	return !!(vn && vn.vertices && vn.vertices.length >= 2);
}

function findLineVectorInContainer(container) {
	if (!container || !container.children) return null;
	var found = null;
	for (var i = 0; i < container.children.length; i++) {
		var ch = container.children[i];
		if (isMeasuredPathVector(ch)) {
			if (found) return found;
			found = ch;
		}
	}
	return found;
}

function findLabelInContainer(container) {
	if (!container) return null;
	if (container.getPluginData && container.getPluginData("pluginLabel") === "1") return container;
	if (!container.children) return null;
	for (var i = 0; i < container.children.length; i++) {
		var ch = container.children[i];
		if (ch.getPluginData && ch.getPluginData("pluginLabel") === "1") return ch;
	}
	if (typeof container.findAll === "function") {
		var labels = findLabelsInContainer(container);
		return labels.length > 0 ? labels[0] : null;
	}
	return null;
}

function getVectorAndLabelFromPluginGroup(group) {
	return {
		vector: findLineVectorInContainer(group),
		pill: findLabelInContainer(group),
	};
}

function readLineEntryFromNode(node) {
	if (!node || !node.getPluginData) return null;
	return parseLineEntryJson(node.getPluginData(PLUGIN_LINE_ENTRY));
}

function readLineEntryFromVector(vector) {
	var entry = readLineEntryFromNode(vector);
	if (entry) return entry;
	var group = getPluginLineGroupForVector(vector);
	if (group) return readLineEntryFromNode(group);
	return null;
}

function solidPaintToHex(paint) {
	if (!paint || paint.type !== "SOLID" || !paint.color) return null;
	var c = paint.color;
	var r = Math.round(c.r * 255);
	var g = Math.round(c.g * 255);
	var b = Math.round(c.b * 255);
	return (
		"#" +
		[r, g, b]
			.map(function (x) {
				var h = x.toString(16);
				return h.length === 1 ? "0" + h : h;
			})
			.join("")
	);
}

function getFirstSolidFillHex(node) {
	if (!node || !("fills" in node) || node.fills === figma.mixed) return null;
	var fills = node.fills;
	if (!fills || !fills.length) return null;
	return solidPaintToHex(fills[0]);
}

function getFirstSolidStrokeHex(node) {
	if (!node || !("strokes" in node) || node.strokes === figma.mixed) return null;
	var strokes = node.strokes;
	if (!strokes || !strokes.length) return null;
	return solidPaintToHex(strokes[0]);
}

function buildEntryFromDiscoveredPair(vector, pill, group) {
	var textId = null;
	var fontSize = DEFAULT_UI_SETTINGS.fontSize;
	if (pill && pill.type === "FRAME" && pill.children) {
		for (var ci = 0; ci < pill.children.length; ci++) {
			if (pill.children[ci].type === "TEXT") {
				textId = pill.children[ci].id;
				fontSize = pill.children[ci].fontSize || fontSize;
				break;
			}
		}
	} else if (pill && pill.type === "TEXT") {
		textId = pill.id;
		fontSize = pill.fontSize || fontSize;
	}

	var pathLength = getTotalPathLength(vector);
	var globalScale = parseFloat(figma.root.getPluginData("globalScale")) || 0;
	var scaleInfo = resolveScaleForNode(vector, globalScale);
	var labelHex = (pill && getFirstSolidFillHex(pill)) || DEFAULT_UI_SETTINGS.labelColor;
	var lineHex = getFirstSolidStrokeHex(vector) || labelHex;

	return {
		textId: textId,
		pillId: pill ? pill.id : null,
		groupId: group ? group.id : null,
		pxPerCm: scaleInfo.pxPerCm,
		labelColor: labelHex,
		lineColor: lineHex,
		fontSize: fontSize,
		lastPathLength: pathLength,
		labelManuallyMoved: true,
		labelPlacement: DEFAULT_UI_SETTINGS.labelPlacement,
		lineWidth: vector.strokeWeight || DEFAULT_UI_SETTINGS.lineWidth,
		pointHeightsByPointIndex: {},
		elevationsCmByPointIndex: {},
		pointMarkerIds: [],
		heightBadgeIds: [],
		slopeBadgeIds: [],
		colorIndex: -1,
	};
}

async function persistLineEntryToNodes(vectorId, groupId, entry) {
	var json = JSON.stringify(entry);
	try {
		var vector = await figma.getNodeByIdAsync(vectorId);
		if (vector) vector.setPluginData(PLUGIN_LINE_ENTRY, json);
	} catch (e) {}
	if (groupId) {
		try {
			var group = await figma.getNodeByIdAsync(groupId);
			if (group) group.setPluginData(PLUGIN_LINE_ENTRY, json);
		} catch (e) {}
	} else {
		try {
			var vector2 = await figma.getNodeByIdAsync(vectorId);
			var grp = vector2 ? getPluginLineGroupForVector(vector2) : null;
			if (grp) grp.setPluginData(PLUGIN_LINE_ENTRY, json);
		} catch (e2) {}
	}
}

async function registerDiscoveredLine(vector, entry) {
	await repairMeasuredLineEntry(vector, entry);
	measuredLines[vector.id] = entry;
	await persistLineEntryToNodes(vector.id, entry.groupId, entry);
}

async function repairMeasuredLineEntry(vector, entry) {
	var changed = false;
	var pillOk = entry.pillId && (await nodeExists(entry.pillId));
	if (!pillOk) {
		var pill = await findLabelForVector(vector);
		if (pill) {
			entry.pillId = pill.id;
			entry.textId = null;
			if (pill.type === "FRAME" && pill.children) {
				for (var ci = 0; ci < pill.children.length; ci++) {
					if (pill.children[ci].type === "TEXT") {
						entry.textId = pill.children[ci].id;
						break;
					}
				}
			}
			pill.setPluginData(PLUGIN_LINE_VECTOR_ID, vector.id);
			changed = true;
		}
	} else {
		try {
			var existingPill = await figma.getNodeByIdAsync(entry.pillId);
			if (existingPill) existingPill.setPluginData(PLUGIN_LINE_VECTOR_ID, vector.id);
		} catch (e) {}
	}

	var parent = vector.parent;
	if (parent && parent.getPluginData && parent.getPluginData("pluginGroup") === "1") {
		if (entry.groupId !== parent.id) {
			entry.groupId = parent.id;
			changed = true;
		}
	}

	if (changed) {
		vector.setPluginData(PLUGIN_LINE_ENTRY, JSON.stringify(entry));
	}
	return entry;
}

async function restoreMeasuredLinesFromIndex() {
	var savedIndex2 = figma.root.getPluginData("measuredLinesIndex");
	if (!savedIndex2) return;
	try {
		var index = JSON.parse(savedIndex2);
		for (var i = 0; i < index.length; i++) {
			var nodeId = index[i];
			try {
				var node = await figma.getNodeByIdAsync(nodeId);
				if (node && node.type === "VECTOR") {
					var entry = readLineEntryFromVector(node);
					if (entry) {
						await repairMeasuredLineEntry(node, entry);
						measuredLines[nodeId] = entry;
					}
				}
			} catch (e) {}
		}
	} catch (e) {}
}

async function discoverMeasuredLinesFromDocument() {
	await figma.loadAllPagesAsync();
	var found = 0;
	for (var pi = 0; pi < figma.root.children.length; pi++) {
		var page = figma.root.children[pi];
		var vectors = page.findAll(function (n) {
			if (n.type !== "VECTOR" || !isMeasuredPathVector(n)) return false;
			if (n.getPluginData && n.getPluginData(PLUGIN_LINE_ENTRY)) return true;
			var grp = getPluginLineGroupForVector(n);
			return !!(grp && grp.getPluginData && grp.getPluginData(PLUGIN_LINE_ENTRY));
		});
		for (var vi = 0; vi < vectors.length; vi++) {
			var vector = vectors[vi];
			if (measuredLines[vector.id]) continue;
			var entry = readLineEntryFromVector(vector);
			if (!entry) continue;
			await registerDiscoveredLine(vector, entry);
			found++;
		}
	}
	if (found > 0) saveMeasuredLinesIndex();
	return found;
}

async function discoverMeasuredLinesFromPluginGroups() {
	await figma.loadAllPagesAsync();
	var found = 0;
	for (var pi = 0; pi < figma.root.children.length; pi++) {
		var page = figma.root.children[pi];
		var groups = page.findAll(function (n) {
			return n.getPluginData && n.getPluginData("pluginGroup") === "1";
		});
		for (var gi = 0; gi < groups.length; gi++) {
			var group = groups[gi];
			var pair = getVectorAndLabelFromPluginGroup(group);
			if (!pair.vector || measuredLines[pair.vector.id]) continue;
			var entry = readLineEntryFromNode(group) || readLineEntryFromVector(pair.vector);
			if (!entry) {
				if (!pair.pill && !group.getPluginData(PLUGIN_LINE_ENTRY)) continue;
				entry = buildEntryFromDiscoveredPair(pair.vector, pair.pill, group);
			}
			entry.groupId = group.id;
			await registerDiscoveredLine(pair.vector, entry);
			found++;
		}
	}
	if (found > 0) saveMeasuredLinesIndex();
	return found;
}

async function discoverMeasuredLinesFromLabels() {
	await figma.loadAllPagesAsync();
	var found = 0;
	for (var pi = 0; pi < figma.root.children.length; pi++) {
		var page = figma.root.children[pi];
		var labels = page.findAll(function (n) {
			return n.getPluginData && n.getPluginData("pluginLabel") === "1";
		});
		for (var li = 0; li < labels.length; li++) {
			var pill = labels[li];
			var parent = pill.parent;
			var vector = null;
			var group = null;
			if (parent && parent.getPluginData && parent.getPluginData("pluginGroup") === "1") {
				group = parent;
				vector = findLineVectorInContainer(parent);
			} else if (parent) {
				var siblings = listMeasuredPathVectorsInContainer(parent);
				if (siblings.length === 1) vector = siblings[0];
				else if (siblings.length > 1) vector = pickClosestVector(siblings, pill);
			}
			if (!vector || measuredLines[vector.id]) continue;
			var entry = readLineEntryFromVector(vector);
			if (!entry) entry = buildEntryFromDiscoveredPair(vector, pill, group);
			if (group) entry.groupId = group.id;
			await registerDiscoveredLine(vector, entry);
			found++;
		}
	}
	if (found > 0) saveMeasuredLinesIndex();
	return found;
}

async function restoreDiscoveredLineAppearance() {
	var keys = Object.keys(measuredLines);
	if (keys.length === 0) return;
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	for (var i = 0; i < keys.length; i++) {
		var nodeId = keys[i];
		var entry = measuredLines[nodeId];
		if (!entry) continue;
		try {
			var vNode = await figma.getNodeByIdAsync(nodeId);
			if (!vNode || vNode.type !== "VECTOR") continue;
			if (entry.lineColor) {
				vNode.strokes = [{ type: "SOLID", color: hexToRgb(entry.lineColor) }];
			}
			if (entry.lineWidth) vNode.strokeWeight = entry.lineWidth;
			var lNode = null;
			if (entry.pillId) lNode = await figma.getNodeByIdAsync(entry.pillId);
			if (!lNode && entry.textId) lNode = await figma.getNodeByIdAsync(entry.textId);
			if (lNode) await updateLabel(vNode, lNode, entry, false);
		} catch (e) {}
	}
}

function isCalibrationContainerNode(n) {
	if (!n || !n.getPluginData) return false;
	if (n.type !== "FRAME" && n.type !== "GROUP" && n.type !== "SECTION") return false;
	if (n.getPluginData("pluginGroup") === "1") return false;
	return true;
}

function getImmediateCalibrationContainer(node) {
	var current = node && node.parent;
	while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
		if (current.getPluginData && current.getPluginData("pluginGroup") === "1") {
			current = current.parent;
			continue;
		}
		if (isCalibrationContainerNode(current)) return current;
		current = current.parent;
	}
	return null;
}

async function scanDocumentForNodeScales() {
	await figma.loadAllPagesAsync();
	var found = [];
	var seen = {};
	for (var pi = 0; pi < figma.root.children.length; pi++) {
		var page = figma.root.children[pi];
		var containers = page.findAll(function (n) {
			if (!isCalibrationContainerNode(n)) return false;
			var raw = n.getPluginData("nodeScale");
			return !!(raw && parseFloat(raw) > 0);
		});
		for (var ci = 0; ci < containers.length; ci++) {
			var c = containers[ci];
			if (seen[c.id]) continue;
			seen[c.id] = true;
			found.push({
				id: c.id,
				name: c.name || "Frame",
				pxPerCm: parseFloat(c.getPluginData("nodeScale")),
			});
		}
	}
	return found;
}

async function inferFrameScalesFromMeasuredLines() {
	var keys = Object.keys(measuredLines);
	for (var i = 0; i < keys.length; i++) {
		var entry = measuredLines[keys[i]];
		if (!entry || !(entry.pxPerCm > 0)) continue;
		try {
			var vector = await figma.getNodeByIdAsync(keys[i]);
			if (!vector) continue;
			var container = getImmediateCalibrationContainer(vector);
			if (!container) continue;
			var existing = container.getPluginData("nodeScale");
			if (existing && parseFloat(existing) > 0) continue;
			saveNodeScale(container, entry.pxPerCm);
		} catch (e) {}
	}
}

async function discoverNodeScalesFromDocument() {
	var scanned = await scanDocumentForNodeScales();
	for (var i = 0; i < scanned.length; i++) {
		try {
			var node = await figma.getNodeByIdAsync(scanned[i].id);
			if (node) saveNodeScale(node, scanned[i].pxPerCm);
		} catch (e) {}
	}
	await inferFrameScalesFromMeasuredLines();
}

function restoreMissingDocumentPluginData() {
	var keys = Object.keys(measuredLines);
	if (keys.length === 0) return;

	var globalScale = parseFloat(figma.root.getPluginData("globalScale"));
	if (!isFinite(globalScale) || globalScale <= 0) {
		for (var gi = 0; gi < keys.length; gi++) {
			var ge = measuredLines[keys[gi]];
			if (ge && ge.pxPerCm > 0) {
				saveGlobalScale(ge.pxPerCm);
				break;
			}
		}
	}

	if (!figma.root.getPluginData("uiSettings")) {
		var inferred = null;
		for (var ui = 0; ui < keys.length; ui++) {
			inferred = uiSettingsFromLineEntry(measuredLines[keys[ui]]);
			if (inferred) break;
		}
		if (!inferred) {
			var sample = measuredLines[keys[0]];
			if (sample) {
				inferred = {
					colorMode: DEFAULT_UI_SETTINGS.colorMode,
					lineColor: sample.lineColor || DEFAULT_UI_SETTINGS.lineColor,
					labelColor: sample.labelColor || DEFAULT_UI_SETTINGS.labelColor,
					fontSize: sample.fontSize || DEFAULT_UI_SETTINGS.fontSize,
					labelPlacement: sample.labelPlacement || DEFAULT_UI_SETTINGS.labelPlacement,
					lineWidth: sample.lineWidth || DEFAULT_UI_SETTINGS.lineWidth,
					showPointMarkers: DEFAULT_UI_SETTINGS.showPointMarkers,
					elevationDisplayAtPoints: DEFAULT_UI_SETTINGS.elevationDisplayAtPoints,
					showHeightBadges: DEFAULT_UI_SETTINGS.showHeightBadges,
					showDiffBadges: DEFAULT_UI_SETTINGS.showDiffBadges,
					showSlopeBadges: DEFAULT_UI_SETTINGS.showSlopeBadges,
				};
			}
		}
		if (inferred) saveUiSettings(inferred);
	}
}

async function init() {
	// 1. Restore global scale from document root
	var savedScale = figma.root.getPluginData("globalScale");
	var savedIndex = figma.root.getPluginData("lineColorIndex");
	if (savedIndex) lineColorIndex = parseInt(savedIndex) || 0;

	// 2. Restore tracked lines from root index, then scan copied layers (lineEntry on vectors)
	await restoreMeasuredLinesFromIndex();
	await discoverMeasuredLinesFromDocument();
	await discoverMeasuredLinesFromPluginGroups();
	await discoverMeasuredLinesFromLabels();
	await discoverNodeScalesFromDocument();
	restoreMissingDocumentPluginData();
	// Lines may carry frame pxPerCm while frame nodeScale was lost on paste — infer again after global restore.
	await inferFrameScalesFromMeasuredLines();
	await restoreDiscoveredLineAppearance();
	await scheduleSyncElevationVisuals(true);

	// 3. Send restored state + calibrations list to UI
	var calibrations = await getNodeScalesList();
	// Also fetch root groups for save-to dropdown
	var rootGroupsInit = [];
	var pageChildren = figma.currentPage.children;
	for (var rgi = 0; rgi < pageChildren.length; rgi++) {
		var rch = pageChildren[rgi];
		if (
			(rch.type === "FRAME" || rch.type === "GROUP" || rch.type === "SECTION") &&
			rch.getPluginData("pluginGroup") !== "1"
		) {
			var rchScale = rch.getPluginData("nodeScale");
			rootGroupsInit.push({
				id: rch.id,
				name: rch.name,
				hasScale: !!(rchScale && parseFloat(rchScale) > 0),
				pxPerCm: rchScale ? parseFloat(rchScale) : null,
			});
		}
	}
	// Store for sending once UI signals it's ready
	pendingRestoreData = {
		type: "restored",
		globalScale: savedScale ? parseFloat(savedScale) : null,
		lineCount: Object.keys(measuredLines).length,
		calibrations: calibrations,
		rootGroups: rootGroupsInit,
		settings: readUiSettings(),
	};

	// Send now — UI may already be ready (reopening plugin)
	// If not, ui-ready message will trigger it
	figma.ui.postMessage(pendingRestoreData);

	// 4. Now safe to register documentchange
	figma.on("documentchange", handleDocumentChange);
}

figma.loadAllPagesAsync().then(init);

// ── Persist helpers ───────────────────────────────────────────────────────────

function saveGlobalScale(pxPerCm) {
	figma.root.setPluginData("globalScale", String(pxPerCm));
}

function saveLineColorIndex() {
	figma.root.setPluginData("lineColorIndex", String(lineColorIndex));
}

function saveMeasuredLine(nodeId, entry) {
	ensureEntryDefaults(entry);
	attachUiPrefsToEntry(entry);
	measuredLines[nodeId] = entry;
	persistLineEntryToNodes(nodeId, entry.groupId, entry);
	saveMeasuredLinesIndex();
}

function removeMeasuredLine(nodeId) {
	var old = measuredLines[nodeId];
	delete measuredLines[nodeId];
	if (old) {
		var markerIds = (old.pointMarkerIds || []).concat(old.heightBadgeIds || []).concat(old.slopeBadgeIds || []);
		for (var mi = 0; mi < markerIds.length; mi++) {
			var markerId = markerIds[mi];
			try {
				figma.getNodeByIdAsync(markerId).then(function (n) {
					if (n) n.remove();
				});
			} catch (e0) {}
		}
	}
	try {
		figma.getNodeByIdAsync(nodeId).then(function (node) {
			if (node) node.setPluginData(PLUGIN_LINE_ENTRY, "");
			var grp = node ? getPluginLineGroupForVector(node) : null;
			if (grp) grp.setPluginData(PLUGIN_LINE_ENTRY, "");
		});
	} catch (e) {}
	if (old && old.groupId) {
		try {
			figma.getNodeByIdAsync(old.groupId).then(function (grp) {
				if (grp) grp.setPluginData(PLUGIN_LINE_ENTRY, "");
			});
		} catch (e2) {}
	}
	saveMeasuredLinesIndex();
}

function saveMeasuredLinesIndex() {
	var keys = Object.keys(measuredLines);
	figma.root.setPluginData("measuredLinesIndex", JSON.stringify(keys));
}

// Save scale on a specific frame/group node
function saveNodeScale(node, pxPerCm) {
	// Store scale on the node itself — this is the source of truth
	node.setPluginData("nodeScale", String(pxPerCm));
	// Index only stores id+name for lookup — pxPerCm is always read live from node
	var raw = figma.root.getPluginData("nodeScalesIndex");
	var index = [];
	try {
		index = raw ? JSON.parse(raw) : [];
	} catch (e) {
		index = [];
	}
	var found = false;
	for (var i = 0; i < index.length; i++) {
		if (index[i].id === node.id) {
			index[i].name = node.name;
			found = true;
			break;
		}
	}
	if (!found) index.push({ id: node.id, name: node.name });
	figma.root.setPluginData("nodeScalesIndex", JSON.stringify(index));
}

async function getNodeScalesList() {
	// Scan layers for nodeScale (survives copy/paste); index alone is not enough in a new file.
	var result = await scanDocumentForNodeScales();
	var cleanIndex = result.map(function (item) {
		return { id: item.id, name: item.name };
	});
	figma.root.setPluginData("nodeScalesIndex", JSON.stringify(cleanIndex));

	var globalScale = figma.root.getPluginData("globalScale");
	if (globalScale && parseFloat(globalScale) > 0) {
		result.unshift({ id: "global", name: "Global", pxPerCm: parseFloat(globalScale) });
	}
	return result;
}

// Walk up parent chain to find nearest frame/group with a saved scale
// Skips plugin-generated groups (named 'Line: ...' or flagged with pluginData)
function resolveScaleForNode(node, globalPxPerCm) {
	var current = node.parent;
	while (current && current.type !== "DOCUMENT" && current.type !== "PAGE") {
		// Skip our own generated groups
		var isPluginGroup = current.getPluginData("pluginGroup") === "1";
		if (!isPluginGroup) {
			var stored = current.getPluginData("nodeScale");
			if (stored && parseFloat(stored) > 0) {
				return { pxPerCm: parseFloat(stored), source: current.name || "frame" };
			}
		}
		current = current.parent;
	}
	return { pxPerCm: globalPxPerCm, source: "global" };
}

function getSelectionScaleInfo() {
	var sel = figma.currentPage.selection;
	var globalScale = parseFloat(figma.root.getPluginData("globalScale")) || 0;
	if (!sel || sel.length === 0) {
		return { pxPerCm: globalScale, source: "global" };
	}
	return resolveScaleForNode(sel[0], globalScale);
}

function postSelectionScaleInfo() {
	var info = getSelectionScaleInfo();
	figma.ui.postMessage({ type: "scale-info", pxPerCm: info.pxPerCm, source: info.source });
}

async function getElevationDataForSelection() {
	var out = [];
	var ids = collectMeasuredVectorIdsFromSelection(figma.currentPage.selection);
	for (var i = 0; i < ids.length; i++) {
		var vectorId = ids[i];
		var entry = measuredLines[vectorId];
		if (!entry) continue;
		ensureEntryDefaults(entry);
		try {
			var n = await figma.getNodeByIdAsync(vectorId);
			if (!n || n.type !== "VECTOR") continue;
			sanitizePointHeightsForLine(entry, n);
			out.push({
				vectorId: vectorId,
				name: n.name || "Line",
				pointCount: n.vectorNetwork && n.vectorNetwork.vertices ? n.vectorNetwork.vertices.length : 0,
				pointHeightsByPointIndex: entry.pointHeightsByPointIndex,
			});
		} catch (e) {}
	}
	return out;
}

async function hideAllElevationMarkers() {
	var keys = Object.keys(measuredLines);
	for (var i = 0; i < keys.length; i++) {
		var entry = measuredLines[keys[i]];
		if (!entry) continue;
		ensureEntryDefaults(entry);
		await removePointMarkers(entry);
		await removeHeightBadges(entry);
		await removeSlopeBadges(entry);
		saveMeasuredLine(keys[i], entry);
	}
}

/** P markers for selected vector, label, or plugin line group (not all lines in a parent frame). */
function collectPointMarkerVectorIdsFromSelection(selection) {
	var out = {};
	var selectedIds = {};
	for (var si = 0; si < selection.length; si++) selectedIds[selection[si].id] = true;

	var measuredIds = Object.keys(measuredLines);
	for (var mi = 0; mi < measuredIds.length; mi++) {
		var vid = measuredIds[mi];
		var entry = measuredLines[vid];
		if (!entry) continue;
		if (selectedIds[vid]) {
			out[vid] = true;
			continue;
		}
		if (entry.groupId && selectedIds[entry.groupId]) {
			out[vid] = true;
			continue;
		}
		if (entry.pillId && selectedIds[entry.pillId]) {
			out[vid] = true;
			continue;
		}
		if (entry.textId && selectedIds[entry.textId]) {
			out[vid] = true;
			continue;
		}
	}

	for (var i = 0; i < selection.length; i++) {
		var n = selection[i];
		if (n.type === "VECTOR" && measuredLines[n.id]) out[n.id] = true;
		if (n.getPluginData && n.getPluginData("pluginGroup") === "1" && typeof n.findAll === "function") {
			var vectors = n.findAll(function (child) {
				return child.type === "VECTOR" && !!measuredLines[child.id];
			});
			for (var vi = 0; vi < vectors.length; vi++) out[vectors[vi].id] = true;
		}
	}
	return Object.keys(out);
}

function scheduleSyncElevationVisuals(immediate) {
	function enqueue() {
		elevationVisualsSyncChain = elevationVisualsSyncChain
			.catch(function () {
				return undefined;
			})
			.then(function () {
				return syncElevationVisuals();
			});
		return elevationVisualsSyncChain;
	}

	if (immediate) {
		if (elevationSyncDebounceTimer) {
			clearTimeout(elevationSyncDebounceTimer);
			elevationSyncDebounceTimer = null;
		}
		return enqueue();
	}

	if (elevationSyncDebounceTimer) clearTimeout(elevationSyncDebounceTimer);
	elevationSyncDebounceTimer = setTimeout(function () {
		elevationSyncDebounceTimer = null;
		enqueue();
	}, ELEVATION_SYNC_DEBOUNCE_MS);
	return elevationVisualsSyncChain;
}

async function ensureElevationFontsLoaded() {
	if (elevationFontLoaded) return;
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	elevationFontLoaded = true;
}

function lineHasElevationData(entry) {
	ensureEntryDefaults(entry);
	var raw = entry.pointHeightsByPointIndex || {};
	var keys = Object.keys(raw);
	for (var i = 0; i < keys.length; i++) {
		if (raw[keys[i]] && typeof raw[keys[i]] === "object") return true;
	}
	return false;
}

async function removeElevationVisualsForEntry(entry) {
	if (!entry) return;
	ensureEntryDefaults(entry);
	var ids = (entry.pointMarkerIds || []).concat(entry.heightBadgeIds || []).concat(entry.slopeBadgeIds || []);
	for (var i = 0; i < ids.length; i++) {
		try {
			var n = await figma.getNodeByIdAsync(ids[i]);
			if (n) n.remove();
		} catch (e) {}
	}
	entry.pointMarkerIds = [];
	entry.heightBadgeIds = [];
	entry.slopeBadgeIds = [];
}

async function syncElevationVisuals() {
	var gen = ++elevationVisualsGeneration;
	elevationSyncInProgress = true;
	var touchedLineIds = [];

	try {
		await ensureElevationFontsLoaded();
		if (gen !== elevationVisualsGeneration) return;

		var keys = Object.keys(measuredLines);
		var settings = readUiSettings();
		var atPoints = settings.elevationDisplayAtPoints;
		var selectedIds = collectPointMarkerVectorIdsFromSelection(figma.currentPage.selection);
		var selectedSet = {};
		for (var si = 0; si < selectedIds.length; si++) selectedSet[selectedIds[si]] = true;

		for (var ki = 0; ki < keys.length; ki++) {
			if (gen !== elevationVisualsGeneration) return;
			var vectorId = keys[ki];
			var entry = measuredLines[vectorId];
			if (!entry) continue;

			var isSelected = !!selectedSet[vectorId];
			var hasElev = lineHasElevationData(entry);
			var shouldRender = isSelected || hasElev;

			if (
				!shouldRender &&
				!(entry.pointMarkerIds && entry.pointMarkerIds.length) &&
				!(entry.heightBadgeIds && entry.heightBadgeIds.length) &&
				!(entry.slopeBadgeIds && entry.slopeBadgeIds.length)
			) {
				continue;
			}

			await removeElevationVisualsForEntry(entry);
			if (!shouldRender) {
				touchedLineIds.push(vectorId);
				continue;
			}

			if (gen !== elevationVisualsGeneration) return;
			try {
				var v = await figma.getNodeByIdAsync(vectorId);
				if (!v || v.type !== "VECTOR") continue;

				if (atPoints) {
					var showP = settings.showPointMarkers !== false && isSelected;
					await renderPointInfoForLine(v, entry, showP, gen);
				} else {
					if (settings.showPointMarkers !== false && isSelected) {
						await renderPointMarkersForLine(v, entry, gen);
					}
					if (hasElev && (settings.showHeightBadges || settings.showDiffBadges)) {
						await renderHeightBadgesForLine(v, entry);
					}
				}
				if (settings.showSlopeBadges && hasElev) {
					await renderSlopeBadgesForLine(v, entry);
				}
				touchedLineIds.push(vectorId);
			} catch (e) {}
		}

		if (gen === elevationVisualsGeneration && touchedLineIds.length > 0) {
			bringElevationVisualsToFront();
		}
	} finally {
		elevationSyncInProgress = false;
		if (gen === elevationVisualsGeneration) {
			for (var ti = 0; ti < touchedLineIds.length; ti++) {
				var tid = touchedLineIds[ti];
				if (measuredLines[tid]) saveMeasuredLine(tid, measuredLines[tid]);
			}
		}
	}
}

async function postSelectionElevationInfo() {
	figma.ui.postMessage({
		type: "elevation-data",
		lines: await getElevationDataForSelection(),
		showPointMarkers: readUiSettings().showPointMarkers,
		elevationDisplayAtPoints: readUiSettings().elevationDisplayAtPoints,
		showHeightBadges: readUiSettings().showHeightBadges,
		showDiffBadges: readUiSettings().showDiffBadges,
		showSlopeBadges: readUiSettings().showSlopeBadges,
	});
}

function collectMeasuredVectorIdsFromSelection(selection) {
	var out = {};
	var measuredIds = Object.keys(measuredLines);
	for (var i = 0; i < selection.length; i++) {
		var n = selection[i];
		if (measuredLines[n.id]) {
			out[n.id] = true;
			continue;
		}
		// If user selects a label pill/text directly, map it back to its vector.
		for (var mi = 0; mi < measuredIds.length; mi++) {
			var vid = measuredIds[mi];
			var entry = measuredLines[vid];
			if (entry && (entry.pillId === n.id || entry.textId === n.id)) {
				out[vid] = true;
				break;
			}
		}
		// Also support selecting plugin groups/frames containing measured vectors
		if (typeof n.findAll === "function") {
			var vectors = n.findAll(function (child) {
				return child.type === "VECTOR" && !!measuredLines[child.id];
			});
			for (var vi = 0; vi < vectors.length; vi++) out[vectors[vi].id] = true;
		}
	}
	return Object.keys(out);
}

// ── Document change handler ───────────────────────────────────────────────────

async function handleDocumentChange(event) {
	if (elevationSyncInProgress) return;

	var markersNeedRefresh = false;
	for (var i = 0; i < event.documentChanges.length; i++) {
		var change = event.documentChanges[i];
		var nodeId = change.id;

		var entry = measuredLines[nodeId];
		if (entry && change.type === "PROPERTY_CHANGE") {
			try {
				var vectorNode = await figma.getNodeByIdAsync(nodeId);
				var labelNode = await figma.getNodeByIdAsync(entry.pillId || entry.textId);
				if (!vectorNode || !labelNode || vectorNode.type !== "VECTOR") continue;

				var newLength = getTotalPathLength(vectorNode);
				var geometryChanged = Math.abs(newLength - entry.lastPathLength) > 0.5;

				// Check if the line moved to a different parent (different frame/group scale)
				var globalScale = parseFloat(figma.root.getPluginData("globalScale")) || entry.pxPerCm;
				var newScaleInfo = resolveScaleForNode(vectorNode, globalScale);
				var scaleChanged = Math.abs(newScaleInfo.pxPerCm - entry.pxPerCm) > 0.0001;

				await figma.loadFontAsync({ family: "Inter", style: "Bold" });
				if (geometryChanged || scaleChanged) {
					entry.lastPathLength = newLength;
					entry.pxPerCm = newScaleInfo.pxPerCm;
					entry.labelManuallyMoved = false;
					await updateLabel(vectorNode, labelNode, entry, true);
					saveMeasuredLine(nodeId, entry);
					markersNeedRefresh = true;
				} else {
					await updateLabel(vectorNode, labelNode, entry, false);
				}
			} catch (e) {
				removeMeasuredLine(nodeId);
			}
			continue;
		}

		// Detect manual label move
		var entryKeys = Object.keys(measuredLines);
		for (var k = 0; k < entryKeys.length; k++) {
			var e = measuredLines[entryKeys[k]];
			var isLabel = e.pillId === nodeId || e.textId === nodeId;
			if (isLabel && change.type === "PROPERTY_CHANGE") {
				if (isNodeChangeSuppressed(nodeId)) continue;
				e.labelManuallyMoved = true;
				saveMeasuredLine(entryKeys[k], e);
			}
		}
	}
	if (markersNeedRefresh) {
		scheduleSyncElevationVisuals();
		await postSelectionElevationInfo();
	}
}

figma.on("selectionchange", function () {
	postSelectionScaleInfo();
	scheduleSyncElevationVisuals().then(function () {
		postSelectionElevationInfo();
	});
});

// ── Message handler ───────────────────────────────────────────────────────────

figma.ui.onmessage = async function (msg) {
	// ── UI ready — resend restore data if needed ─────────────
	if (msg.type === "ui-ready") {
		if (pendingRestoreData) {
			figma.ui.postMessage(pendingRestoreData);
		} else {
			// Plugin was opened before init finished — send minimal state
			var cals = await getNodeScalesList();
			var rootGs = [];
			var pc = figma.currentPage.children;
			for (var ri = 0; ri < pc.length; ri++) {
				var rc = pc[ri];
				if (
					(rc.type === "FRAME" || rc.type === "GROUP" || rc.type === "SECTION") &&
					rc.getPluginData("pluginGroup") !== "1"
				) {
					var rcs = rc.getPluginData("nodeScale");
					rootGs.push({
						id: rc.id,
						name: rc.name,
						hasScale: !!(rcs && parseFloat(rcs) > 0),
						pxPerCm: rcs ? parseFloat(rcs) : null,
					});
				}
			}
			var gs = figma.root.getPluginData("globalScale");
			figma.ui.postMessage({
				type: "restored",
				globalScale: gs ? parseFloat(gs) : null,
				lineCount: Object.keys(measuredLines).length,
				calibrations: cals,
				rootGroups: rootGs,
				settings: readUiSettings(),
			});
		}
		postSelectionScaleInfo();
		await postSelectionElevationInfo();
	}

	if (msg.type === "save-settings") {
		saveUiSettings(msg.settings || {});
		if (
			msg.settings &&
			(typeof msg.settings.showPointMarkers !== "undefined" ||
				typeof msg.settings.elevationDisplayAtPoints !== "undefined" ||
				typeof msg.settings.showHeightBadges !== "undefined" ||
				typeof msg.settings.showDiffBadges !== "undefined" ||
				typeof msg.settings.showSlopeBadges !== "undefined")
		) {
			await scheduleSyncElevationVisuals(true);
		}
	}

	if (msg.type === "get-elevation-data") {
		figma.ui.postMessage({
			type: "elevation-data",
			lines: await getElevationDataForSelection(),
			showPointMarkers: readUiSettings().showPointMarkers !== false,
			elevationDisplayAtPoints: readUiSettings().elevationDisplayAtPoints,
			showHeightBadges: readUiSettings().showHeightBadges,
			showDiffBadges: readUiSettings().showDiffBadges,
			showSlopeBadges: readUiSettings().showSlopeBadges,
		});
	}

	if (msg.type === "set-point-elevations") {
		var updates = msg.updates || {};
		var lineIds = Object.keys(updates);
		for (var ui = 0; ui < lineIds.length; ui++) {
			var lineId = lineIds[ui];
			var entry = measuredLines[lineId];
			if (!entry) continue;
			try {
				var vNode = await figma.getNodeByIdAsync(lineId);
				if (!vNode || vNode.type !== "VECTOR") continue;
				ensureEntryDefaults(entry);
				var merged = Object.assign({}, entry.pointHeightsByPointIndex || {});
				var incoming = updates[lineId] || {};
				var inKeys = Object.keys(incoming);
				for (var ik = 0; ik < inKeys.length; ik++) {
					if (incoming[inKeys[ik]] == null) delete merged[inKeys[ik]];
					else merged[inKeys[ik]] = incoming[inKeys[ik]];
				}
				entry.pointHeightsByPointIndex = merged;
				entry.elevationsCmByPointIndex = {};
				sanitizePointHeightsForLine(entry, vNode);
				var lNode = await figma.getNodeByIdAsync(entry.pillId || entry.textId);
				if (lNode) await updateLabel(vNode, lNode, entry, !entry.labelManuallyMoved);
				saveMeasuredLine(lineId, entry);
			} catch (e) {}
		}
		await scheduleSyncElevationVisuals(true);
		await postSelectionElevationInfo();
		figma.ui.postMessage({ type: "result", text: "✓ Elevations updated" });
	}

	if (msg.type === "toggle-point-markers") {
		var s = readUiSettings();
		s.showPointMarkers = msg.show !== false;
		saveUiSettings(s);
		await scheduleSyncElevationVisuals(true);
		figma.ui.postMessage({
			type: "elevation-data",
			lines: await getElevationDataForSelection(),
			showPointMarkers: s.showPointMarkers,
			elevationDisplayAtPoints: s.elevationDisplayAtPoints,
			showHeightBadges: s.showHeightBadges,
			showDiffBadges: s.showDiffBadges,
			showSlopeBadges: s.showSlopeBadges,
		});
	}

	// ── Measure ──────────────────────────────────────────────
	if (msg.type === "measure") {
		var pxPerCm = msg.pxPerCm;
		var fontSize = msg.fontSize;
		var colorMode = msg.colorMode;
		var labelColor = msg.labelColor;
		var lineColor = msg.lineColor;
		var labelPlacement = msg.labelPlacement || "above";
		var lineWidth = Math.max(1, Math.min(64, parseFloat(msg.lineWidth) || 8));
		var selection = figma.currentPage.selection;

		if (selection.length === 0) {
			figma.ui.postMessage({ type: "error", text: "Select one or more vector lines first." });
			return;
		}

		await figma.loadFontAsync({ family: "Inter", style: "Bold" });
		saveGlobalScale(pxPerCm);

		var results = [];
		var movedLabelIds = [];

		for (var i = 0; i < selection.length; i++) {
			var node = selection[i];

			if (node.type !== "VECTOR") {
				figma.ui.postMessage({ type: "error", text: "Select Vector lines only (drawn with the Pen tool)." });
				return;
			}

			// Resolve scale: use frame/group scale if set, else use the passed global
			var scaleInfo = resolveScaleForNode(node, pxPerCm);
			var usedScale = scaleInfo.pxPerCm;
			var pathLength = getTotalPathLength(node);
			var resolved = resolveColors(colorMode, labelColor, lineColor, node.id);

			node.strokes = [{ type: "SOLID", color: hexToRgb(resolved.line) }];
			node.strokeWeight = lineWidth;

			// Update existing
			if (measuredLines[node.id]) {
				var ex = measuredLines[node.id];
				var geomChanged = Math.abs(pathLength - ex.lastPathLength) > 0.5;
				ex.pxPerCm = usedScale;
				ex.labelColor = resolved.label;
				ex.lineColor = resolved.line;
				ex.fontSize = fontSize || 14;
				ex.labelPlacement = labelPlacement;
				ex.lineWidth = lineWidth;
				ex.lastPathLength = pathLength;
				if (geomChanged) ex.labelManuallyMoved = false;

				try {
					var exLabel = await figma.getNodeByIdAsync(ex.pillId || ex.textId);
					if (exLabel) {
						var shouldReposition = geomChanged || !ex.labelManuallyMoved;
						// Respect manual placement: only auto-reposition when geometry changed
						// or when the label has not been manually moved.
						await updateLabel(node, exLabel, ex, shouldReposition);
						if (shouldReposition) movedLabelIds.push(exLabel.id);
						saveMeasuredLine(node.id, ex);
						results.push(
							formatLength(getDisplayedLengthCm(node, ex)) +
								(scaleInfo.source !== "global" ? " [" + scaleInfo.source + "]" : ""),
						);
						continue;
					}
				} catch (e2) {}
			}

			// New line
			if (colorMode !== "manual") lineColorIndex++;
			saveLineColorIndex();

			var labelText = formatLength(
				getDisplayedLengthCm(node, { pxPerCm: usedScale, elevationsCmByPointIndex: {} }),
			);

			// Keep the original parent so the line stays in its frame/group
			var originalParent = node.parent || figma.currentPage;
			var groupParent = originalParent.type === "PAGE" ? figma.currentPage : originalParent;

			// Create pill label
			var pillResult = await createPill(labelText, fontSize || 14, resolved.label);
			var pill = pillResult.pill;
			var text = pillResult.text;

			groupParent.appendChild(pill);
			linkPillToVector(pill, node.id);
			positionLabelParallel(node, pill, labelPlacement);
			movedLabelIds.push(pill.id);

			var group = figma.group([node, pill], groupParent);
			group.name = "Line: " + labelText;
			group.setPluginData("pluginGroup", "1"); // mark so scale lookup skips it

			var newEntry = {
				textId: text.id,
				pillId: pill.id,
				groupId: group.id,
				pxPerCm: usedScale,
				labelColor: resolved.label,
				lineColor: resolved.line,
				fontSize: fontSize || 14,
				lastPathLength: pathLength,
				labelManuallyMoved: false,
				labelPlacement: labelPlacement,
				lineWidth: lineWidth,
				pointHeightsByPointIndex: {},
				elevationsCmByPointIndex: {},
				pointMarkerIds: [],
				heightBadgeIds: [],
				slopeBadgeIds: [],
				colorIndex: colorMode !== "manual" ? lineColorIndex - 1 : -1,
			};
			saveMeasuredLine(node.id, newEntry);
			results.push(
				formatLength(getDisplayedLengthCm(node, newEntry)) +
					(scaleInfo.source !== "global" ? " [" + scaleInfo.source + "]" : ""),
			);
		}
		await relaxMovableLabelOverlaps(movedLabelIds, 3);
		await scheduleSyncElevationVisuals(true);
		await postSelectionElevationInfo();

		figma.ui.postMessage({ type: "result", text: "✓ Measured: " + results.join(" · ") });
	}

	// ── Calibrate globally ────────────────────────────────────
	if (msg.type === "calibrate") {
		var sel = figma.currentPage.selection;
		if (sel.length !== 1 || sel[0].type !== "VECTOR") {
			figma.ui.postMessage({ type: "error", text: "Select exactly one vector line to calibrate." });
			return;
		}
		var totalPx = getTotalPathLength(sel[0]);
		var knownCm = parseFloat(msg.knownCm);
		var saveTo = msg.saveTo || "global";
		if (!knownCm || knownCm <= 0) {
			figma.ui.postMessage({ type: "error", text: "Enter a valid known distance." });
			return;
		}
		var pxPerCm = totalPx / knownCm;
		var savedToName = "none";

		if (saveTo === "global") {
			saveGlobalScale(pxPerCm);
			savedToName = "Global";
		} else if (saveTo !== "none") {
			try {
				var targetNode = await figma.getNodeByIdAsync(saveTo);
				if (targetNode) {
					saveNodeScale(targetNode, pxPerCm);
					savedToName = targetNode.name;
				}
			} catch (e) {}
		}

		var cals = await getNodeScalesList();
		figma.ui.postMessage({
			type: "calibrated",
			pxPerCm: pxPerCm,
			savedTo: savedToName,
			calibrations: cals,
		});
	}

	// ── Get root-level groups/frames for save-to dropdown ────
	if (msg.type === "get-root-groups") {
		var groups = [];
		var children = figma.currentPage.children;
		for (var ci = 0; ci < children.length; ci++) {
			var ch = children[ci];
			if (
				(ch.type === "FRAME" || ch.type === "GROUP" || ch.type === "SECTION") &&
				ch.getPluginData("pluginGroup") !== "1"
			) {
				var existingScale = ch.getPluginData("nodeScale");
				groups.push({
					id: ch.id,
					name: ch.name,
					hasScale: !!(existingScale && parseFloat(existingScale) > 0),
					pxPerCm: existingScale ? parseFloat(existingScale) : null,
				});
			}
		}
		figma.ui.postMessage({ type: "root-groups", groups: groups });
	}

	// ── Save calibration to global or a specific node ─────────
	if (msg.type === "save-calibration") {
		var pxPerCm = msg.pxPerCm;
		if (msg.target === "global") {
			saveGlobalScale(pxPerCm);
			var cals = await getNodeScalesList();
			figma.ui.postMessage({ type: "calibrations", list: cals });
			figma.ui.postMessage({ type: "result", text: "✓ Global scale set: " + pxPerCm + " px/cm" });
		} else if (msg.target === "none") {
			// Just use in session, don't save anywhere
			figma.ui.postMessage({ type: "result", text: "✓ Scale ready: " + pxPerCm + " px/cm (not saved)" });
		} else {
			// Save to a specific node by id
			try {
				var targetNode = await figma.getNodeByIdAsync(msg.target);
				if (targetNode) {
					saveNodeScale(targetNode, pxPerCm);
					var cals = await getNodeScalesList();
					figma.ui.postMessage({ type: "calibrations", list: cals });
					figma.ui.postMessage({
						type: "result",
						text: "✓ Scale " + pxPerCm + ' px/cm saved to "' + targetNode.name + '"',
					});
				}
			} catch (e) {
				figma.ui.postMessage({ type: "error", text: "Could not find the selected frame." });
			}
		}
	}

	// ── Remove a saved calibration ────────────────────────────
	if (msg.type === "remove-calibration") {
		if (msg.id === "global") {
			figma.root.setPluginData("globalScale", "");
		} else {
			try {
				var n = await figma.getNodeByIdAsync(msg.id);
				if (n) n.setPluginData("nodeScale", "");
			} catch (e) {}
			// Remove from index
			var raw = figma.root.getPluginData("nodeScalesIndex");
			var index = [];
			try {
				index = raw ? JSON.parse(raw) : [];
			} catch (e2) {
				index = [];
			}
			var newIndex = [];
			for (var ni = 0; ni < index.length; ni++) {
				if (index[ni].id !== msg.id) newIndex.push(index[ni]);
			}
			figma.root.setPluginData("nodeScalesIndex", JSON.stringify(newIndex));
		}
		var cals = await getNodeScalesList();
		figma.ui.postMessage({ type: "calibrations", list: cals });
		figma.ui.postMessage({ type: "result", text: "✓ Calibration removed" });
	}

	// ── Get all saved calibrations ───────────────────────────
	if (msg.type === "get-calibrations") {
		var cals = await getNodeScalesList();
		figma.ui.postMessage({ type: "calibrations", list: cals });
	}

	// ── Override scale used when measuring (link to calibration) ─
	if (msg.type === "override-measure-scale") {
		// Just save it as the active global — the UI sends this when user picks from list
		saveGlobalScale(msg.pxPerCm);
		figma.ui.postMessage({ type: "scale-active", pxPerCm: msg.pxPerCm, name: msg.name });
	}

	// ── Set scale on selected frame/group ─────────────────────
	if (msg.type === "set-node-scale") {
		var sel = figma.currentPage.selection;
		if (sel.length !== 1) {
			figma.ui.postMessage({ type: "error", text: "Select exactly one frame or group to assign a scale to." });
			return;
		}
		var target = sel[0];
		if (target.type !== "FRAME" && target.type !== "GROUP" && target.type !== "SECTION") {
			figma.ui.postMessage({ type: "error", text: "Select a frame or group (not a line) to assign a scale." });
			return;
		}
		saveNodeScale(target, msg.pxPerCm);
		// Do NOT update global scale here — frame scale is independent
		var updatedCals = await getNodeScalesList();
		figma.ui.postMessage({ type: "calibrations", list: updatedCals });
		figma.ui.postMessage({
			type: "result",
			text: "✓ Scale " + msg.pxPerCm + ' px/cm saved on "' + (target.name || "frame") + '"',
		});
	}

	// ── Get scale for current selection ──────────────────────
	if (msg.type === "get-selection-scale") {
		var info = getSelectionScaleInfo();
		figma.ui.postMessage({ type: "scale-info", pxPerCm: info.pxPerCm, source: info.source });
	}

	// ── Recalculate all ───────────────────────────────────────
	if (msg.type === "recalculate-all") {
		var pxPerCm = msg.pxPerCm;
		var fontSize = msg.fontSize;
		var colorMode = msg.colorMode;
		var labelColor = msg.labelColor;
		var lineColor = msg.lineColor;
		var labelPlacement = msg.labelPlacement || "above";
		var lineWidth = Math.max(1, Math.min(64, parseFloat(msg.lineWidth) || 8));

		await figma.loadFontAsync({ family: "Inter", style: "Bold" });
		saveGlobalScale(pxPerCm);

		var count = 0;
		var keys = Object.keys(measuredLines);
		var movedLabelIds = [];

		for (var k = 0; k < keys.length; k++) {
			var nodeId = keys[k];
			var entry = measuredLines[nodeId];

			var resolved;
			if (colorMode === "manual") {
				resolved = { line: lineColor, label: labelColor };
			} else {
				var palette = colorMode === "auto-dark" ? PALETTES.dark : PALETTES.light;
				var idx = entry.colorIndex >= 0 ? entry.colorIndex : 0;
				resolved = { line: palette[idx % palette.length], label: palette[idx % palette.length] };
			}

			try {
				var vNode = await figma.getNodeByIdAsync(nodeId);
				var lNode = await figma.getNodeByIdAsync(entry.pillId || entry.textId);
				if (vNode && lNode) {
					// Per-node scale takes priority
					var scaleInfo = resolveScaleForNode(vNode, pxPerCm);
					entry.pxPerCm = scaleInfo.pxPerCm;
					entry.labelColor = resolved.label;
					entry.lineColor = resolved.line;
					entry.fontSize = fontSize || 14;
					entry.labelPlacement = labelPlacement;
					entry.lineWidth = lineWidth;

					vNode.strokes = [{ type: "SOLID", color: hexToRgb(resolved.line) }];
					vNode.strokeWeight = lineWidth;

					var newLen = getTotalPathLength(vNode);
					var geomChanged = Math.abs(newLen - entry.lastPathLength) > 0.5;
					entry.lastPathLength = newLen;
					if (geomChanged) entry.labelManuallyMoved = false;
					// Respect manual placement unless geometry changed.
					var shouldReposition = geomChanged || !entry.labelManuallyMoved;
					await updateLabel(vNode, lNode, entry, shouldReposition);
					if (shouldReposition) movedLabelIds.push(lNode.id);
					saveMeasuredLine(nodeId, entry);

					if (entry.groupId) {
						var grp = await figma.getNodeByIdAsync(entry.groupId);
						if (grp) grp.name = "Line: " + formatLength(getDisplayedLengthCm(vNode, entry));
					}
					count++;
				} else {
					removeMeasuredLine(nodeId);
				}
			} catch (e) {
				removeMeasuredLine(nodeId);
			}
		}

		// Extra settle rounds for auto-positioned labels only.
		// Manual-moved labels are intentionally left untouched.
		for (var round = 0; round < 5; round++) {
			var settleKeys = Object.keys(measuredLines);
			for (var sk = 0; sk < settleKeys.length; sk++) {
				var settleNodeId = settleKeys[sk];
				var settleEntry = measuredLines[settleNodeId];
				if (settleEntry.labelManuallyMoved) continue;
				try {
					var svNode = await figma.getNodeByIdAsync(settleNodeId);
					var slNode = await figma.getNodeByIdAsync(settleEntry.pillId || settleEntry.textId);
					if (svNode && slNode) {
						await updateLabel(svNode, slNode, settleEntry, true);
						saveMeasuredLine(settleNodeId, settleEntry);
					}
				} catch (se) {
					/* ignore settle failures per-node */
				}
			}
		}
		await relaxMovableLabelOverlaps(movedLabelIds, 4);
		figma.ui.postMessage({ type: "result", text: "✓ Updated " + count + " line(s)" });
		await scheduleSyncElevationVisuals(true);
	}

	// ── Reset label position ──────────────────────────────────
	if (msg.type === "reset-label-position") {
		var targetIds = collectMeasuredVectorIdsFromSelection(figma.currentPage.selection);
		var movedLabelIds = [];
		for (var i = 0; i < targetIds.length; i++) {
			var vectorId = targetIds[i];
			var entry = measuredLines[vectorId];
			if (entry) {
				try {
					var vNode = await figma.getNodeByIdAsync(vectorId);
					var lNode = await figma.getNodeByIdAsync(entry.pillId || entry.textId);
					if (vNode && lNode) {
						entry.labelManuallyMoved = false;
						await updateLabel(vNode, lNode, entry, true);
						movedLabelIds.push(lNode.id);
						saveMeasuredLine(vectorId, entry);
					}
				} catch (e) {}
			}
		}
		// Settle pass for selected labels so stagger/collision gets recomputed together.
		for (var round = 0; round < 4; round++) {
			for (var si = 0; si < targetIds.length; si++) {
				var settleId = targetIds[si];
				var settleEntry = measuredLines[settleId];
				if (!settleEntry) continue;
				try {
					var sv = await figma.getNodeByIdAsync(settleId);
					var sl = await figma.getNodeByIdAsync(settleEntry.pillId || settleEntry.textId);
					if (sv && sl) {
						await updateLabel(sv, sl, settleEntry, true);
						saveMeasuredLine(settleId, settleEntry);
					}
				} catch (se) {}
			}
		}
		await relaxMovableLabelOverlaps(movedLabelIds, 4);
		await scheduleSyncElevationVisuals(true);
		await postSelectionElevationInfo();
		figma.ui.postMessage({ type: "result", text: "✓ Label position reset" });
	}
};

// ── Update label ──────────────────────────────────────────────────────────────

async function updateLabel(vectorNode, pillOrText, entry, reposition) {
	var totalCm = getDisplayedLengthCm(vectorNode, entry);
	var labelText = formatLength(totalCm);

	// Support both pill (new) and plain text (legacy) labels
	if (entry.pillId && pillOrText.type === "FRAME") {
		// Pill mode — find text child
		var textChild = null;
		for (var ci = 0; ci < pillOrText.children.length; ci++) {
			if (pillOrText.children[ci].type === "TEXT") {
				textChild = pillOrText.children[ci];
				break;
			}
		}
		if (textChild) {
			suppressNodeChanges([pillOrText.id, textChild.id]);
			await updatePill(pillOrText, textChild, labelText, entry.fontSize || 14, entry.labelColor);
			unsuppressNodeChanges([pillOrText.id, textChild.id]);
		}
		if (reposition) positionLabelParallel(vectorNode, pillOrText, entry.labelPlacement);
	} else {
		// Legacy plain text
		suppressNodeChanges(pillOrText.id);
		await figma.loadFontAsync({ family: "Inter", style: "Bold" });
		pillOrText.characters = labelText;
		pillOrText.fontSize = entry.fontSize || 14;
		pillOrText.fills = [{ type: "SOLID", color: hexToRgb(entry.labelColor) }];
		if (reposition) positionLabelParallel(vectorNode, pillOrText, entry.labelPlacement);
		unsuppressNodeChanges(pillOrText.id);
	}
	if (entry.groupId) {
		try {
			var grp = await figma.getNodeByIdAsync(entry.groupId);
			if (grp) grp.name = "Line: " + labelText;
		} catch (e2) {}
	}
}

// ── Resolve colors ────────────────────────────────────────────────────────────

function resolveColors(colorMode, manualLabel, manualLine, nodeId) {
	if (colorMode === "manual") return { line: manualLine, label: manualLabel };
	var palette = colorMode === "auto-dark" ? PALETTES.dark : PALETTES.light;
	var entry = measuredLines[nodeId];
	var idx = entry && entry.colorIndex >= 0 ? entry.colorIndex : lineColorIndex;
	var hex = palette[idx % palette.length];
	return { line: hex, label: hex };
}

function getNodeAABBAbsolute(node) {
	var t = node.absoluteTransform;
	var w = node.width || 0;
	var h = node.height || 0;
	var p1 = { x: t[0][2], y: t[1][2] };
	var p2 = { x: t[0][0] * w + t[0][2], y: t[1][0] * w + t[1][2] };
	var p3 = { x: t[0][1] * h + t[0][2], y: t[1][1] * h + t[1][2] };
	var p4 = { x: t[0][0] * w + t[0][1] * h + t[0][2], y: t[1][0] * w + t[1][1] * h + t[1][2] };
	var minX = Math.min(p1.x, p2.x, p3.x, p4.x);
	var maxX = Math.max(p1.x, p2.x, p3.x, p4.x);
	var minY = Math.min(p1.y, p2.y, p3.y, p4.y);
	var maxY = Math.max(p1.y, p2.y, p3.y, p4.y);
	return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

function getLabelAABBForCandidate(textNode, parentNode, centerX, centerY, angleRad) {
	var w = textNode.width || 0;
	var h = textNode.height || 0;
	var hw = w / 2;
	var hh = h / 2;
	var cosA = Math.cos(angleRad);
	var sinA = Math.sin(angleRad);

	var corners = [
		{ x: -hw, y: -hh },
		{ x: hw, y: -hh },
		{ x: -hw, y: hh },
		{ x: hw, y: hh },
	];

	var pt = parentNode.absoluteTransform;
	var minX = Number.POSITIVE_INFINITY;
	var minY = Number.POSITIVE_INFINITY;
	var maxX = Number.NEGATIVE_INFINITY;
	var maxY = Number.NEGATIVE_INFINITY;

	for (var i = 0; i < corners.length; i++) {
		var c = corners[i];
		var localX = centerX + c.x * cosA - c.y * sinA;
		var localY = centerY + c.x * sinA + c.y * cosA;
		var absX = pt[0][0] * localX + pt[0][1] * localY + pt[0][2];
		var absY = pt[1][0] * localX + pt[1][1] * localY + pt[1][2];
		if (absX < minX) minX = absX;
		if (absX > maxX) maxX = absX;
		if (absY < minY) minY = absY;
		if (absY > maxY) maxY = absY;
	}
	return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
}

function rectsOverlap(a, b, pad) {
	var p = pad || 0;
	return !(a.maxX + p <= b.minX || a.minX >= b.maxX + p || a.maxY + p <= b.minY || a.minY >= b.maxY + p);
}

function overlapArea(a, b, pad) {
	var p = pad || 0;
	var left = Math.max(a.minX, b.minX - p);
	var right = Math.min(a.maxX, b.maxX + p);
	var top = Math.max(a.minY, b.minY - p);
	var bottom = Math.min(a.maxY, b.maxY + p);
	if (right <= left || bottom <= top) return 0;
	return (right - left) * (bottom - top);
}

async function relaxMovableLabelOverlaps(movableLabelIds, rounds) {
	if (!movableLabelIds || movableLabelIds.length === 0) return;
	var movableSet = {};
	for (var i = 0; i < movableLabelIds.length; i++) {
		if (movableLabelIds[i]) movableSet[movableLabelIds[i]] = true;
	}

	for (var round = 0; round < (rounds || 2); round++) {
		var allLabels = figma.currentPage.findAll(function (n) {
			return n.getPluginData && n.getPluginData("pluginLabel") === "1";
		});
		var states = [];
		for (var li = 0; li < allLabels.length; li++) {
			var lbl = allLabels[li];
			var b = getNodeAABBAbsolute(lbl);
			var cx = (b.minX + b.maxX) * 0.5;
			var cy = (b.minY + b.maxY) * 0.5;
			var rt = lbl.relativeTransform;
			var tx = rt[0][0];
			var ty = rt[1][0];
			var tLen = Math.sqrt(tx * tx + ty * ty) || 1;
			states.push({
				id: lbl.id,
				node: lbl,
				bounds: b,
				cx: cx,
				cy: cy,
				tx: tx / tLen,
				ty: ty / tLen,
				width: lbl.width || 0,
				movable: !!movableSet[lbl.id],
			});
		}

		var deltaById = {};
		for (var si = 0; si < states.length; si++) {
			if (states[si].movable) deltaById[states[si].id] = 0;
		}

		for (var a = 0; a < states.length; a++) {
			var A = states[a];
			if (!A.movable) continue;
			for (var b = 0; b < states.length; b++) {
				if (a === b) continue;
				var B = states[b];
				var pad = Math.max(8, Math.min(20, (A.width + B.width) * 0.05));
				if (!rectsOverlap(A.bounds, B.bounds, pad)) continue;

				var overlapX = Math.min(A.bounds.maxX, B.bounds.maxX) - Math.max(A.bounds.minX, B.bounds.minX);
				var overlapY = Math.min(A.bounds.maxY, B.bounds.maxY) - Math.max(A.bounds.minY, B.bounds.minY);
				var penetration = Math.max(6, Math.min(60, Math.min(overlapX, overlapY) + pad));

				var proj = (A.cx - B.cx) * A.tx + (A.cy - B.cy) * A.ty;
				var sign;
				if (Math.abs(proj) < 1) sign = A.id > B.id ? 1 : -1;
				else sign = proj >= 0 ? 1 : -1;
				deltaById[A.id] += sign * penetration * 0.55;
			}
		}

		var movedAny = false;
		var deltaIds = Object.keys(deltaById);
		for (var di = 0; di < deltaIds.length; di++) {
			var id = deltaIds[di];
			var delta = deltaById[id];
			if (Math.abs(delta) < 0.5) continue;
			var st = null;
			for (var sj = 0; sj < states.length; sj++) {
				if (states[sj].id === id) {
					st = states[sj];
					break;
				}
			}
			if (!st) continue;
			var maxStep = Math.max(12, st.width * 0.9);
			var clamped = Math.max(-maxStep, Math.min(maxStep, delta));
			var dx = st.tx * clamped;
			var dy = st.ty * clamped;
			var rt2 = st.node.relativeTransform;
			suppressNodeChanges(st.node.id);
			st.node.relativeTransform = [
				[rt2[0][0], rt2[0][1], rt2[0][2] + dx],
				[rt2[1][0], rt2[1][1], rt2[1][2] + dy],
			];
			unsuppressNodeChanges(st.node.id);
			movedAny = true;
		}
		if (!movedAny) break;
	}
}

// ── Position label at true 50% path midpoint ─────────────────────────────────

// placement: 'above' | 'below' | 'center'
function positionLabelParallel(vectorNode, textNode, placement) {
	if (!placement) placement = "above";
	var network = vectorNode.vectorNetwork;
	if (!network || network.vertices.length < 2) return;

	var segments = [];
	var totalLen = 0;

	for (var i = 0; i < network.segments.length; i++) {
		var seg = network.segments[i];
		var s = network.vertices[seg.start];
		var e = network.vertices[seg.end];
		var ts = seg.tangentStart;
		var te = seg.tangentEnd;
		var curved = (ts && (ts.x !== 0 || ts.y !== 0)) || (te && (te.x !== 0 || te.y !== 0));
		var len = curved
			? cubicBezierLength(
					s,
					{ x: s.x + (ts ? ts.x : 0), y: s.y + (ts ? ts.y : 0) },
					{ x: e.x + (te ? te.x : 0), y: e.y + (te ? te.y : 0) },
					e,
				)
			: Math.sqrt(Math.pow(e.x - s.x, 2) + Math.pow(e.y - s.y, 2));
		var startDist = totalLen;
		segments.push({
			s: s,
			e: e,
			ts: ts,
			te: te,
			len: len,
			curved: curved,
			startDist: startDist,
			endDist: startDist + len,
		});
		totalLen += len;
	}

	function evaluateAtDistance(distanceAlongPath) {
		var targetDist = Math.max(0, Math.min(totalLen, distanceAlongPath));
		var walkedDist = 0;
		var point = { x: 0, y: 0 };
		var tan = { x: 1, y: 0 };
		var segIndex = 0;
		var tOnSeg = 0;

		for (var sj = 0; sj < segments.length; sj++) {
			var segItem = segments[sj];
			if (walkedDist + segItem.len >= targetDist || sj === segments.length - 1) {
				var tLocal = segItem.len > 0 ? (targetDist - walkedDist) / segItem.len : 0;
				tLocal = Math.max(0, Math.min(1, tLocal));
				segIndex = sj;
				tOnSeg = tLocal;

				if (segItem.curved) {
					var cp0 = segItem.s;
					var cp1 = {
						x: segItem.s.x + (segItem.ts ? segItem.ts.x : 0),
						y: segItem.s.y + (segItem.ts ? segItem.ts.y : 0),
					};
					var cp2 = {
						x: segItem.e.x + (segItem.te ? segItem.te.x : 0),
						y: segItem.e.y + (segItem.te ? segItem.te.y : 0),
					};
					var cp3 = segItem.e;
					var mtLocal = 1 - tLocal;
					point.x =
						mtLocal * mtLocal * mtLocal * cp0.x +
						3 * mtLocal * mtLocal * tLocal * cp1.x +
						3 * mtLocal * tLocal * tLocal * cp2.x +
						tLocal * tLocal * tLocal * cp3.x;
					point.y =
						mtLocal * mtLocal * mtLocal * cp0.y +
						3 * mtLocal * mtLocal * tLocal * cp1.y +
						3 * mtLocal * tLocal * tLocal * cp2.y +
						tLocal * tLocal * tLocal * cp3.y;
					tan.x =
						3 * mtLocal * mtLocal * (cp1.x - cp0.x) +
						6 * mtLocal * tLocal * (cp2.x - cp1.x) +
						3 * tLocal * tLocal * (cp3.x - cp2.x);
					tan.y =
						3 * mtLocal * mtLocal * (cp1.y - cp0.y) +
						6 * mtLocal * tLocal * (cp2.y - cp1.y) +
						3 * tLocal * tLocal * (cp3.y - cp2.y);
				} else {
					point.x = segItem.s.x + tLocal * (segItem.e.x - segItem.s.x);
					point.y = segItem.s.y + tLocal * (segItem.e.y - segItem.s.y);
					tan.x = segItem.e.x - segItem.s.x;
					tan.y = segItem.e.y - segItem.s.y;
				}
				break;
			}
			walkedDist += segItem.len;
		}

		return { point: point, tangent: tan, segmentIndex: segIndex, tOnSegment: tOnSeg };
	}

	var target = totalLen * 0.5;
	var evalMid = evaluateAtDistance(target);

	// Placement strategy:
	// 1) Place on a single segment (between two points), not on full path midpoint.
	// 2) Prefer the longest segment that can fit the label.
	// 3) If multiple fit similarly, prefer the one closer to overall path middle.
	// 4) If none can fit, still use the longest segment and place in its midpoint.
	var minFitLen = Math.max(24, textNode.width * 0.9);
	var chosenSeg = null;
	var longestSeg = null;
	for (var si = 0; si < segments.length; si++) {
		var segCandidate = segments[si];
		if (!longestSeg || segCandidate.len > longestSeg.len) longestSeg = segCandidate;
		if (segCandidate.len < minFitLen) continue;

		if (!chosenSeg) {
			chosenSeg = segCandidate;
			continue;
		}

		var lenDelta = segCandidate.len - chosenSeg.len;
		if (lenDelta > 4) {
			chosenSeg = segCandidate;
			continue;
		}
		if (Math.abs(lenDelta) <= 4) {
			var candCenter = segCandidate.startDist + segCandidate.len * 0.5;
			var chosenCenter = chosenSeg.startDist + chosenSeg.len * 0.5;
			if (Math.abs(candCenter - target) < Math.abs(chosenCenter - target)) {
				chosenSeg = segCandidate;
			}
		}
	}
	if (!chosenSeg) chosenSeg = longestSeg;
	evalMid = evaluateAtDistance(chosenSeg.startDist + chosenSeg.len * 0.5);

	var midPt = evalMid.point;
	var tangent = evalMid.tangent;

	// Convert midpoint and tangent from vector-local space to parent space.
	// This keeps label alignment correct even when the vector itself is transformed/rotated.
	var vt = vectorNode.relativeTransform;
	var va = vt[0][0];
	var vc = vt[0][1];
	var ve = vt[0][2];
	var vb = vt[1][0];
	var vd = vt[1][1];
	var vf = vt[1][2];

	var midParentX = va * midPt.x + vc * midPt.y + ve;
	var midParentY = vb * midPt.x + vd * midPt.y + vf;

	var tanParentX = va * tangent.x + vc * tangent.y;
	var tanParentY = vb * tangent.x + vd * tangent.y;

	var tangentLen = Math.sqrt(tanParentX * tanParentX + tanParentY * tanParentY) || 1;
	var tx = tanParentX / tangentLen;
	var ty = tanParentY / tangentLen;
	var nx = -ty; // unit normal
	var ny = tx;

	var angleRad = Math.atan2(ty, tx);
	// Keep text readable (not upside down)
	if (angleRad > Math.PI / 2) angleRad -= Math.PI;
	if (angleRad < -Math.PI / 2) angleRad += Math.PI;
	// Canonical tangent for along-line collision spreading.
	// This removes dependence on vector draw direction.
	var slideTx = Math.cos(angleRad);
	var slideTy = Math.sin(angleRad);

	// strokeWeight of the line (default 2 if not set)
	var strokeW = vectorNode.strokeWeight || 2;

	// labelH: pill height or text height — textNode is the pill frame
	var labelH = textNode.height || (textNode.fontSize || 14) * 1.6;

	var offsetDist;
	if (placement === "center") {
		offsetDist = 0;
	} else {
		// Half stroke + half pill + breathing room.
		// Slightly larger gap gives a cleaner visual separation on thick strokes.
		offsetDist = strokeW / 2 + labelH / 2 + 6;
		// In Figma's Y-down coordinate system, the unit normal used here points to visual "below".
		// Flip signs so UI semantics are intuitive: Above => up side, Below => down side.
		if (placement === "above") offsetDist = -offsetDist;
	}

	var centerX = midParentX + nx * offsetDist;
	var centerY = midParentY + ny * offsetDist;

	// Try to avoid overlap with other plugin labels already on canvas.
	var parentNode = textNode.parent;
	var otherLabelBounds = [];
	var allLabels = figma.currentPage.findAll(function (n) {
		return n.getPluginData && n.getPluginData("pluginLabel") === "1";
	});
	for (var li = 0; li < allLabels.length; li++) {
		var lbl = allLabels[li];
		if (lbl.id === textNode.id) continue;
		otherLabelBounds.push({ id: lbl.id, bounds: getNodeAABBAbsolute(lbl) });
	}
	var collisionPad = Math.max(8, ((textNode.horizontalPadding || 0) + (textNode.verticalPadding || 0)) * 0.5 + 2);

	function hasOverlap(candidateCenterX, candidateCenterY) {
		var cand = getLabelAABBForCandidate(textNode, parentNode, candidateCenterX, candidateCenterY, angleRad);
		for (var bi = 0; bi < otherLabelBounds.length; bi++) {
			if (rectsOverlap(cand, otherLabelBounds[bi].bounds, collisionPad)) return true;
		}
		return false;
	}

	function getOverlapScore(candidateCenterX, candidateCenterY) {
		var cand = getLabelAABBForCandidate(textNode, parentNode, candidateCenterX, candidateCenterY, angleRad);
		var total = 0;
		for (var bi = 0; bi < otherLabelBounds.length; bi++) {
			total += overlapArea(cand, otherLabelBounds[bi].bounds, collisionPad);
		}
		return total;
	}

	if (otherLabelBounds.length > 0 && hasOverlap(centerX, centerY)) {
		// Only move pills along the line direction to keep visual centering stable.
		var tangentShifts = [0];
		var idHash = 0;
		for (var ih = 0; ih < vectorNode.id.length; ih++) idHash += vectorNode.id.charCodeAt(ih);
		var prefSign = idHash % 2 === 0 ? 1 : -1;
		for (var ti = 1; ti <= 28; ti++) {
			var step = 0.35 * ti;
			tangentShifts.push(prefSign * step);
			tangentShifts.push(-prefSign * step);
		}
		var tangentUnit = Math.max(14, textNode.width * 0.4);

		// Deterministic peer-rank spread:
		// if several labels overlap at base, spread them along tangent by id order
		// with spacing based on pill width, so parallel lines visibly separate.
		var baseAabb = getLabelAABBForCandidate(textNode, parentNode, centerX, centerY, angleRad);
		var overlappingPeerIds = [];
		for (var oi = 0; oi < otherLabelBounds.length; oi++) {
			if (rectsOverlap(baseAabb, otherLabelBounds[oi].bounds, collisionPad)) {
				overlappingPeerIds.push(otherLabelBounds[oi].id);
			}
		}
		if (overlappingPeerIds.length > 0) {
			overlappingPeerIds.push(textNode.id);
			overlappingPeerIds.sort();
			var myIndex = overlappingPeerIds.indexOf(textNode.id);
			var centeredIndex = myIndex - (overlappingPeerIds.length - 1) / 2;
			var spreadUnit = Math.max(textNode.width + collisionPad * 1.25, tangentUnit * 1.8);
			centerX += slideTx * spreadUnit * centeredIndex;
			centerY += slideTy * spreadUnit * centeredIndex;
		}

		var found = false;
		var bestX = centerX;
		var bestY = centerY;
		var bestScore = getOverlapScore(centerX, centerY);

		for (var ts = 0; ts < tangentShifts.length && !found; ts++) {
			if (tangentShifts[ts] === 0) continue;
			var trialX = centerX + slideTx * tangentUnit * tangentShifts[ts];
			var trialY = centerY + slideTy * tangentUnit * tangentShifts[ts];
			if (!hasOverlap(trialX, trialY)) {
				centerX = trialX;
				centerY = trialY;
				found = true;
				break;
			}
			var score = getOverlapScore(trialX, trialY);
			if (score < bestScore) {
				bestScore = score;
				bestX = trialX;
				bestY = trialY;
			}
		}
		// If no fully clean position exists, at least choose the least-overlapping candidate.
		if (!found) {
			centerX = bestX;
			centerY = bestY;
		}
	}

	// Position by transform so visual center stays exact after rotation.
	var cosA = Math.cos(angleRad);
	var sinA = Math.sin(angleRad);
	var w = textNode.width;
	var h = textNode.height;
	var txm = centerX - cosA * (w / 2) + sinA * (h / 2);
	var tym = centerY - sinA * (w / 2) - cosA * (h / 2);

	suppressNodeChanges(textNode.id);
	textNode.relativeTransform = [
		[cosA, -sinA, txm],
		[sinA, cosA, tym],
	];
	unsuppressNodeChanges(textNode.id);
}

// ── Path length ───────────────────────────────────────────────────────────────

function getVectorPointsInParentSpace(vectorNode) {
	var net = vectorNode.vectorNetwork;
	if (!net || !net.vertices) return [];
	var rt = vectorNode.relativeTransform;
	var a = rt[0][0];
	var c = rt[0][1];
	var e = rt[0][2];
	var b = rt[1][0];
	var d = rt[1][1];
	var f = rt[1][2];
	var out = [];
	for (var i = 0; i < net.vertices.length; i++) {
		var v = net.vertices[i];
		out.push({
			index: i,
			x: a * v.x + c * v.y + e,
			y: b * v.x + d * v.y + f,
		});
	}
	return out;
}

function migrateLegacyPointHeights(entry) {
	ensureEntryDefaults(entry);
	var legacy = entry.elevationsCmByPointIndex || {};
	var legacyKeys = Object.keys(legacy);
	for (var li = 0; li < legacyKeys.length; li++) {
		if (entry.pointHeightsByPointIndex[legacyKeys[li]]) continue;
		var val = parseFloat(legacy[legacyKeys[li]]);
		if (!isFinite(val)) continue;
		entry.pointHeightsByPointIndex[legacyKeys[li]] = { startCm: val, endCm: val };
	}
	var keys = Object.keys(entry.pointHeightsByPointIndex || {});
	for (var i = 0; i < keys.length; i++) {
		var item = entry.pointHeightsByPointIndex[keys[i]];
		if (!item || typeof item !== "object") continue;
		if (item.startCm != null || item.endCm != null) continue;
		if (item.mode === "elevation" && isFinite(parseFloat(item.valueCm))) {
			var h = parseFloat(item.valueCm);
			entry.pointHeightsByPointIndex[keys[i]] = { startCm: h, endCm: h };
		} else if (item.mode === "vertical") {
			var from = parseFloat(item.fromCm);
			var to = parseFloat(item.toCm);
			if (isFinite(from) && isFinite(to)) {
				entry.pointHeightsByPointIndex[keys[i]] = { startCm: from, endCm: to };
			} else if (isFinite(parseFloat(item.valueCm))) {
				var v = Math.abs(parseFloat(item.valueCm));
				entry.pointHeightsByPointIndex[keys[i]] = { startCm: 0, endCm: v };
			}
		}
	}
}

function getPointHeightData(entry, pointIndex) {
	ensureEntryDefaults(entry);
	migrateLegacyPointHeights(entry);
	var raw = entry.pointHeightsByPointIndex[String(pointIndex)];
	if (!raw || typeof raw !== "object") return null;
	return raw;
}

function parseHeightCm(val) {
	var n = parseFloat(val);
	return isFinite(n) ? n : null;
}

/** Height where the cable arrives at this point (along the path). */
function getPointHeightStartCm(entry, pointIndex) {
	var d = getPointHeightData(entry, pointIndex);
	if (!d) return null;
	if (d.startCm != null) return parseHeightCm(d.startCm);
	return null;
}

/** Height where the cable leaves this point (along the path). */
function getPointHeightEndCm(entry, pointIndex) {
	var d = getPointHeightData(entry, pointIndex);
	if (!d) return null;
	if (d.endCm != null) return parseHeightCm(d.endCm);
	return null;
}

/** Height badge: only when start and end are equal (level at point). */
function formatPointHeightBadgeText(pointData) {
	if (!pointData || typeof pointData !== "object") return "";
	var s = pointData.startCm != null ? parseHeightCm(pointData.startCm) : null;
	var e = pointData.endCm != null ? parseHeightCm(pointData.endCm) : null;
	if (s == null || e == null) return "";
	if (Math.abs(s - e) >= 0.0001) return "";
	return formatLength(Math.abs(s));
}

function formatPointDiffBadgeText(pointData) {
	if (!pointData || typeof pointData !== "object") return "";
	var s = pointData.startCm != null ? parseHeightCm(pointData.startCm) : null;
	var e = pointData.endCm != null ? parseHeightCm(pointData.endCm) : null;
	if (s == null || e == null) return "";
	var diff = e - s;
	if (Math.abs(diff) < 0.0001) return "";
	var sign = diff > 0 ? "+" : "-";
	return sign + formatLength(Math.abs(diff));
}

/** Slope along plan segment: leave height at start vertex → arrive height at end vertex. */
function formatSlopeSegmentBadgeText(hLeaveCm, hArriveCm) {
	if (hLeaveCm == null || hArriveCm == null) return "";
	var diff = hArriveCm - hLeaveCm;
	if (Math.abs(diff) < 0.0001) return "";
	var sign = diff > 0 ? "+" : "-";
	return sign + formatLength(Math.abs(diff));
}

function vertexToParentSpace(vectorNode, v) {
	var rt = vectorNode.relativeTransform;
	var a = rt[0][0];
	var b = rt[1][0];
	var c = rt[0][1];
	var d = rt[1][1];
	var e = rt[0][2];
	var f = rt[1][2];
	return {
		x: a * v.x + c * v.y + e,
		y: b * v.x + d * v.y + f,
	};
}

function getSegmentMidpointInParentSpace(vectorNode, seg) {
	var net = vectorNode.vectorNetwork;
	var s = net.vertices[seg.start];
	var e = net.vertices[seg.end];
	var ts = seg.tangentStart;
	var te = seg.tangentEnd;
	var curved = (ts && (ts.x !== 0 || ts.y !== 0)) || (te && (te.x !== 0 || te.y !== 0));
	if (!curved) {
		var ps = vertexToParentSpace(vectorNode, s);
		var pe = vertexToParentSpace(vectorNode, e);
		return { x: (ps.x + pe.x) / 2, y: (ps.y + pe.y) / 2 };
	}
	var p0 = { x: s.x, y: s.y };
	var p1 = { x: s.x + (ts ? ts.x : 0), y: s.y + (ts ? ts.y : 0) };
	var p2 = { x: e.x + (te ? te.x : 0), y: e.y + (te ? te.y : 0) };
	var p3 = { x: e.x, y: e.y };
	var t = 0.5;
	var u = 1 - t;
	var lx = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
	var ly = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
	return vertexToParentSpace(vectorNode, { x: lx, y: ly });
}

function isElevationVisualNode(n) {
	if (!n || !n.getPluginData) return false;
	if (n.getPluginData("pluginElevationPointInfo") === "1") return true;
	if (n.getPluginData("pluginElevationPoint") === "1") return true;
	var t = n.getPluginData("pluginElevationBadgeType");
	return t === "height" || t === "diff" || t === "slope";
}

function markElevationAnchor(node, anchorX, anchorY) {
	node.setPluginData("pluginElevationAnchorX", String(anchorX));
	node.setPluginData("pluginElevationAnchorY", String(anchorY));
}

function tagElevationVector(node, vectorId) {
	if (vectorId) node.setPluginData("pluginElevationVectorId", vectorId);
}

function placeElevationVisual(node, centerX, centerY, anchorX, anchorY, vectorId, pinToVertex) {
	node.x = centerX - node.width / 2;
	node.y = centerY - node.height / 2;
	markElevationAnchor(node, anchorX, anchorY);
	tagElevationVector(node, vectorId);
	if (pinToVertex) {
		node.setPluginData("pluginElevationVertexX", String(anchorX));
		node.setPluginData("pluginElevationVertexY", String(anchorY));
	} else {
		node.setPluginData("pluginElevationVertexX", "");
		node.setPluginData("pluginElevationVertexY", "");
	}
}

function bringElevationVisualsToFront() {
	var markers = figma.currentPage.findAll(function (n) {
		return isElevationVisualNode(n);
	});
	for (var i = 0; i < markers.length; i++) {
		var node = markers[i];
		var parent = node.parent;
		if (parent && "appendChild" in parent) {
			try {
				parent.appendChild(node);
			} catch (e) {}
		}
	}
}

function placePointVisualStack(vectorNode, pointIndex, parentNode, pointX, pointY, nodes, gap, idList) {
	if (!nodes || nodes.length === 0) return;
	var vectorId = vectorNode.id;
	var totalH = 0;
	for (var ni = 0; ni < nodes.length; ni++) totalH += nodes[ni].height + (ni > 0 ? gap : 0);
	var cy = pointY - totalH / 2;
	for (var nj = 0; nj < nodes.length; nj++) {
		var node = nodes[nj];
		var centerY = cy + node.height / 2;
		parentNode.appendChild(node);
		placeElevationVisual(node, pointX, centerY, pointX, pointY, vectorId, true);
		idList.push(node.id);
		cy += node.height + gap;
	}
}

function sanitizePointHeightsForLine(entry, vectorNode) {
	ensureEntryDefaults(entry);
	migrateLegacyPointHeights(entry);
	var vertexCount =
		vectorNode && vectorNode.vectorNetwork && vectorNode.vectorNetwork.vertices
			? vectorNode.vectorNetwork.vertices.length
			: 0;
	var clean = {};
	var raw = entry.pointHeightsByPointIndex || {};
	var keys = Object.keys(raw);
	for (var i = 0; i < keys.length; i++) {
		var idx = parseInt(keys[i], 10);
		if (!isFinite(idx) || idx < 0 || idx >= vertexCount) continue;
		var item = raw[keys[i]];
		if (!item || typeof item !== "object") continue;
		var start = item.startCm != null ? parseHeightCm(item.startCm) : null;
		var end = item.endCm != null ? parseHeightCm(item.endCm) : null;
		if (start == null && end == null) continue;
		var row = {};
		if (start != null) row.startCm = start;
		if (end != null) row.endCm = end;
		clean[String(idx)] = row;
	}
	entry.pointHeightsByPointIndex = clean;
	entry.elevationsCmByPointIndex = {};
}

function getPlanLengthCm(vectorNode, entry) {
	if (!entry || !entry.pxPerCm || entry.pxPerCm <= 0) return 0;
	var net = vectorNode.vectorNetwork;
	if (!net || !net.segments || net.segments.length === 0) return 0;
	var planCm = 0;
	for (var i = 0; i < net.segments.length; i++) {
		var seg = net.segments[i];
		var s = net.vertices[seg.start];
		var e = net.vertices[seg.end];
		var ts = seg.tangentStart;
		var te = seg.tangentEnd;
		var curved = (ts && (ts.x !== 0 || ts.y !== 0)) || (te && (te.x !== 0 || te.y !== 0));
		var lenPx = curved
			? cubicBezierLength(
					s,
					{ x: s.x + (ts ? ts.x : 0), y: s.y + (ts ? ts.y : 0) },
					{ x: e.x + (te ? te.x : 0), y: e.y + (te ? te.y : 0) },
					e,
				)
			: Math.sqrt(Math.pow(e.x - s.x, 2) + Math.pow(e.y - s.y, 2));
		planCm += lenPx / entry.pxPerCm;
	}
	return planCm;
}

/** 3D length: vertical at point (|end−start|) + slope on plan segments (end→next start). */
function getDisplayedLengthCm(vectorNode, entry) {
	if (!entry || !entry.pxPerCm || entry.pxPerCm <= 0) return 0;
	var net = vectorNode.vectorNetwork;
	if (!net || !net.segments || net.segments.length === 0) return 0;
	sanitizePointHeightsForLine(entry, vectorNode);

	var totalCm = 0;
	for (var si = 0; si < net.segments.length; si++) {
		var seg = net.segments[si];
		var s = net.vertices[seg.start];
		var e = net.vertices[seg.end];
		var ts = seg.tangentStart;
		var te = seg.tangentEnd;
		var curved = (ts && (ts.x !== 0 || ts.y !== 0)) || (te && (te.x !== 0 || te.y !== 0));
		var lenPx = curved
			? cubicBezierLength(
					s,
					{ x: s.x + (ts ? ts.x : 0), y: s.y + (ts ? ts.y : 0) },
					{ x: e.x + (te ? te.x : 0), y: e.y + (te ? te.y : 0) },
					e,
				)
			: Math.sqrt(Math.pow(e.x - s.x, 2) + Math.pow(e.y - s.y, 2));
		var lenCm2d = lenPx / entry.pxPerCm;
		var hLeave = getPointHeightEndCm(entry, seg.start);
		var hArrive = getPointHeightStartCm(entry, seg.end);
		if (hLeave != null && hArrive != null) {
			var dh = hArrive - hLeave;
			totalCm += Math.sqrt(lenCm2d * lenCm2d + dh * dh);
		} else {
			totalCm += lenCm2d;
		}
	}

	for (var vi = 0; vi < net.vertices.length; vi++) {
		var hs = getPointHeightStartCm(entry, vi);
		var he = getPointHeightEndCm(entry, vi);
		if (hs != null && he != null) totalCm += Math.abs(he - hs);
	}
	return totalCm;
}

async function removePointMarkers(entry) {
	ensureEntryDefaults(entry);
	var ids = entry.pointMarkerIds || [];
	for (var i = 0; i < ids.length; i++) {
		try {
			var n = await figma.getNodeByIdAsync(ids[i]);
			if (n) n.remove();
		} catch (e) {}
	}
	entry.pointMarkerIds = [];
}

async function removeHeightBadges(entry) {
	ensureEntryDefaults(entry);
	var ids = entry.heightBadgeIds || [];
	for (var i = 0; i < ids.length; i++) {
		try {
			var n = await figma.getNodeByIdAsync(ids[i]);
			if (n) n.remove();
		} catch (e) {}
	}
	entry.heightBadgeIds = [];
}

async function removeSlopeBadges(entry) {
	ensureEntryDefaults(entry);
	var ids = entry.slopeBadgeIds || [];
	for (var i = 0; i < ids.length; i++) {
		try {
			var n = await figma.getNodeByIdAsync(ids[i]);
			if (n) n.remove();
		} catch (e) {}
	}
	entry.slopeBadgeIds = [];
}

async function createMarkerPill(text, bgHex, fontSize) {
	return createElevationBadge(text, bgHex, fontSize || 9, "height");
}

async function createElevationBadge(text, bgHex, fontSize, badgeType) {
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	var t = figma.createText();
	t.fontName = { family: "Inter", style: "Bold" };
	t.characters = text;
	t.fontSize = fontSize || 8;
	t.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];

	var f = figma.createFrame();
	f.layoutMode = "HORIZONTAL";
	f.primaryAxisAlignItems = "CENTER";
	f.counterAxisAlignItems = "CENTER";
	var fs = fontSize || 8;
	f.horizontalPadding = fs <= 7 ? 4 : 5;
	f.verticalPadding = fs <= 7 ? 1 : 2;
	f.cornerRadius = 999;
	f.fills = [{ type: "SOLID", color: hexToRgb(bgHex), opacity: 0.92 }];
	f.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.12 }];
	f.strokeWeight = 1;
	f.layoutSizingHorizontal = "HUG";
	f.layoutSizingVertical = "HUG";
	f.appendChild(t);
	f.setPluginData("pluginElevationBadgeType", badgeType || "height");
	f.locked = true;
	return f;
}

var POINT_MARKER_SIZE = 24;
var INFO_POINT_MARKER_SIZE = 18;
var INFO_POINT_DOT_SIZE = 28;
var INFO_POINT_DOT_FONT_SIZE = 7;

function bgColorForPointInfoKind(kind, text) {
	if (kind === "height") return "#8B5CF6";
	if (kind === "diff") return text.charAt(0) === "-" ? "#DC2626" : "#16A34A";
	if (kind === "slope") return text.charAt(0) === "-" ? "#0284C7" : "#0EA5E9";
	return "#8B5CF6";
}

function getPointInfoLines(entry, pointIndex) {
	var lines = [];
	var pointData = getPointHeightData(entry, pointIndex);
	var heightText = formatPointHeightBadgeText(pointData);
	if (heightText) lines.push({ text: heightText, kind: "height" });
	var diffText = formatPointDiffBadgeText(pointData);
	if (diffText) lines.push({ text: diffText, kind: "diff" });
	return lines;
}

async function createCompactPointCircleMarker(text) {
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	var t = figma.createText();
	t.fontName = { family: "Inter", style: "Bold" };
	t.characters = text;
	t.fontSize = 9;
	t.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];

	var circle = figma.createFrame();
	circle.layoutMode = "HORIZONTAL";
	circle.primaryAxisAlignItems = "CENTER";
	circle.counterAxisAlignItems = "CENTER";
	circle.resize(INFO_POINT_MARKER_SIZE, INFO_POINT_MARKER_SIZE);
	circle.cornerRadius = 999;
	circle.fills = [{ type: "SOLID", color: hexToRgb("#1f6feb") }];
	circle.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.15 }];
	circle.strokeWeight = 1;
	circle.clipsContent = false;
	circle.appendChild(t);
	circle.setPluginData("pluginElevationPointInfo", "1");
	circle.locked = true;
	return circle;
}

/** Round dot at a vertex with elevation text inside (at-points mode). */
async function createPointInfoDot(text, bgHex, kind) {
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	var t = figma.createText();
	t.fontName = { family: "Inter", style: "Bold" };
	t.characters = text;
	t.fontSize = INFO_POINT_DOT_FONT_SIZE;
	t.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
	t.textAlignHorizontal = "CENTER";

	var circle = figma.createFrame();
	circle.layoutMode = "HORIZONTAL";
	circle.primaryAxisAlignItems = "CENTER";
	circle.counterAxisAlignItems = "CENTER";
	circle.resize(INFO_POINT_DOT_SIZE, INFO_POINT_DOT_SIZE);
	circle.cornerRadius = INFO_POINT_DOT_SIZE;
	circle.fills = [{ type: "SOLID", color: hexToRgb(bgHex), opacity: 0.92 }];
	circle.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.15 }];
	circle.strokeWeight = 1;
	circle.clipsContent = true;
	circle.appendChild(t);
	circle.setPluginData("pluginElevationPointInfo", "1");
	if (kind) circle.setPluginData("pluginElevationPointInfoKind", kind);
	circle.locked = true;
	return circle;
}

async function renderPointInfoForLine(vectorNode, entry, showPointNumbers, gen) {
	ensureEntryDefaults(entry);
	entry.pointMarkerIds = [];
	var parentNode = vectorNode.parent || figma.currentPage;
	var points = getVectorPointsInParentSpace(vectorNode);
	var gap = 2;

	for (var i = 0; i < points.length; i++) {
		if (gen != null && gen !== elevationVisualsGeneration) return;
		var p = points[i];
		var infoLines = getPointInfoLines(entry, p.index);
		if (!showPointNumbers && infoLines.length === 0) continue;

		var nodes = [];
		if (showPointNumbers) {
			nodes.push(await createCompactPointCircleMarker(String(p.index + 1)));
		}
		for (var li = 0; li < infoLines.length; li++) {
			var row = infoLines[li];
			nodes.push(await createPointInfoDot(row.text, bgColorForPointInfoKind(row.kind, row.text), row.kind));
		}

		placePointVisualStack(vectorNode, p.index, parentNode, p.x, p.y, nodes, gap, entry.pointMarkerIds);
	}
}

async function createPointCircleMarker(text) {
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	var t = figma.createText();
	t.fontName = { family: "Inter", style: "Bold" };
	t.characters = text;
	t.fontSize = 11;
	t.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];

	var circle = figma.createFrame();
	circle.layoutMode = "HORIZONTAL";
	circle.primaryAxisAlignItems = "CENTER";
	circle.counterAxisAlignItems = "CENTER";
	circle.resize(POINT_MARKER_SIZE, POINT_MARKER_SIZE);
	circle.cornerRadius = 999;
	circle.fills = [{ type: "SOLID", color: hexToRgb("#1f6feb") }];
	circle.strokes = [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 0.2 }];
	circle.strokeWeight = 1.5;
	circle.clipsContent = false;
	circle.appendChild(t);
	circle.setPluginData("pluginElevationPoint", "1");
	circle.locked = true;
	return circle;
}

async function renderPointMarkersForLine(vectorNode, entry, gen) {
	ensureEntryDefaults(entry);
	entry.pointMarkerIds = [];
	var parentNode = vectorNode.parent || figma.currentPage;
	var points = getVectorPointsInParentSpace(vectorNode);
	for (var i = 0; i < points.length; i++) {
		if (gen != null && gen !== elevationVisualsGeneration) return;
		var p = points[i];
		var idxLabel = await createPointCircleMarker(String(p.index + 1));
		parentNode.appendChild(idxLabel);
		placeElevationVisual(idxLabel, p.x, p.y, p.x, p.y, vectorNode.id, true);
		entry.pointMarkerIds.push(idxLabel.id);
	}
}

async function renderHeightBadgesForLine(vectorNode, entry) {
	ensureEntryDefaults(entry);
	await removeHeightBadges(entry);
	var settings = readUiSettings();
	if (settings.elevationDisplayAtPoints) return;
	var showHeights = settings.showHeightBadges;
	var showDiffs = settings.showDiffBadges;
	if (!showHeights && !showDiffs) return;
	var parentNode = vectorNode.parent || figma.currentPage;
	var points = getVectorPointsInParentSpace(vectorNode);
	for (var i = 0; i < points.length; i++) {
		var p = points[i];
		var pointData = getPointHeightData(entry, p.index);
		var heightText = showHeights ? formatPointHeightBadgeText(pointData) : "";
		var diffText = showDiffs ? formatPointDiffBadgeText(pointData) : "";
		var badges = [];
		if (heightText) badges.push({ text: heightText, color: "#8B5CF6" });
		if (diffText) {
			badges.push({ text: diffText, color: diffText.charAt(0) === "-" ? "#DC2626" : "#16A34A" });
		}
		if (badges.length === 0) continue;
		var gap = 3;
		var badgeNodes = [];
		for (var bi = 0; bi < badges.length; bi++) {
			var meta = badges[bi];
			var badgeType = meta.text.charAt(0) === "+" || meta.text.charAt(0) === "-" ? "diff" : "height";
			var hLabel = await createElevationBadge(meta.text, meta.color, 8, badgeType);
			badgeNodes.push(hLabel);
		}
		placePointVisualStack(vectorNode, p.index, parentNode, p.x, p.y, badgeNodes, gap, entry.heightBadgeIds);
	}
}

async function renderSlopeBadgesForLine(vectorNode, entry) {
	ensureEntryDefaults(entry);
	await removeSlopeBadges(entry);
	if (!readUiSettings().showSlopeBadges) return;

	var net = vectorNode.vectorNetwork;
	if (!net || !net.segments || net.segments.length === 0) return;
	var parentNode = vectorNode.parent || figma.currentPage;

	for (var si = 0; si < net.segments.length; si++) {
		var seg = net.segments[si];
		var hLeave = getPointHeightEndCm(entry, seg.start);
		var hArrive = getPointHeightStartCm(entry, seg.end);
		var slopeText = formatSlopeSegmentBadgeText(hLeave, hArrive);
		if (!slopeText) continue;

		var mid = getSegmentMidpointInParentSpace(vectorNode, seg);
		var color = slopeText.charAt(0) === "-" ? "#0284C7" : "#0EA5E9";
		var badge = await createElevationBadge(slopeText, color, 8, "slope");
		parentNode.appendChild(badge);
		placeElevationVisual(badge, mid.x, mid.y, mid.x, mid.y, vectorNode.id, false);
		entry.slopeBadgeIds.push(badge.id);
	}
}

function getTotalPathLength(vectorNode) {
	var total = 0;
	var net = vectorNode.vectorNetwork;
	for (var i = 0; i < net.segments.length; i++) {
		var seg = net.segments[i];
		var s = net.vertices[seg.start];
		var e = net.vertices[seg.end];
		var ts = seg.tangentStart;
		var te = seg.tangentEnd;
		var curved = (ts && (ts.x !== 0 || ts.y !== 0)) || (te && (te.x !== 0 || te.y !== 0));
		if (curved) {
			total += cubicBezierLength(
				s,
				{ x: s.x + (ts ? ts.x : 0), y: s.y + (ts ? ts.y : 0) },
				{ x: e.x + (te ? te.x : 0), y: e.y + (te ? te.y : 0) },
				e,
			);
		} else {
			var dx = e.x - s.x;
			var dy = e.y - s.y;
			total += Math.sqrt(dx * dx + dy * dy);
		}
	}
	return total;
}

function cubicBezierLength(p0, p1, p2, p3, steps) {
	if (!steps) steps = 60;
	var length = 0;
	var prev = p0;
	for (var i = 1; i <= steps; i++) {
		var t = i / steps;
		var mt = 1 - t;
		var pt = {
			x: mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x,
			y: mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y,
		};
		var dx = pt.x - prev.x;
		var dy = pt.y - prev.y;
		length += Math.sqrt(dx * dx + dy * dy);
		prev = pt;
	}
	return length;
}

function formatLength(cm) {
	if (cm >= 100000) return (cm / 100000).toFixed(2) + " km";
	if (cm >= 100) return (cm / 100).toFixed(2) + " m";
	return cm.toFixed(2) + " cm";
}

function hexToRgb(hex) {
	var c = hex.replace("#", "");
	return {
		r: parseInt(c.substring(0, 2), 16) / 255,
		g: parseInt(c.substring(2, 4), 16) / 255,
		b: parseInt(c.substring(4, 6), 16) / 255,
	};
}

// Returns true if the hex color is light enough to need dark text
function isLightColor(hex) {
	var rgb = hexToRgb(hex);
	// Perceived luminance
	var lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
	return lum > 0.55;
}

// Create a pill frame containing a text node
async function createPill(labelText, fontSize, bgHex) {
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	var textColor = isLightColor(bgHex) ? { r: 0.1, g: 0.1, b: 0.1 } : { r: 1, g: 1, b: 1 };
	var pad = Math.round((fontSize || 14) * 0.5);

	var text = figma.createText();
	text.fontName = { family: "Inter", style: "Bold" };
	text.characters = labelText;
	text.fontSize = fontSize || 14;
	text.fills = [{ type: "SOLID", color: textColor }];

	var pill = figma.createFrame();
	pill.name = labelText;
	pill.layoutMode = "HORIZONTAL";
	pill.primaryAxisAlignItems = "CENTER";
	pill.counterAxisAlignItems = "CENTER";
	pill.horizontalPadding = pad;
	pill.verticalPadding = Math.round(pad * 0.5);
	pill.cornerRadius = 999;
	pill.fills = [{ type: "SOLID", color: hexToRgb(bgHex) }];
	pill.clipsContent = false;
	pill.appendChild(text);
	pill.layoutSizingHorizontal = "HUG";
	pill.layoutSizingVertical = "HUG";
	pill.setPluginData("pluginLabel", "1");

	return { pill: pill, text: text };
}

function linkPillToVector(pill, vectorId) {
	if (pill && vectorId) pill.setPluginData(PLUGIN_LINE_VECTOR_ID, vectorId);
}

// Update an existing pill's text + color
async function updatePill(pillNode, textNode, labelText, fontSize, bgHex) {
	suppressNodeChanges([textNode.id, pillNode.id]);
	await figma.loadFontAsync({ family: "Inter", style: "Bold" });
	var textColor = isLightColor(bgHex) ? { r: 0.1, g: 0.1, b: 0.1 } : { r: 1, g: 1, b: 1 };
	var pad = Math.round((fontSize || 14) * 0.5);

	textNode.characters = labelText;
	textNode.fontSize = fontSize || 14;
	textNode.fills = [{ type: "SOLID", color: textColor }];

	pillNode.fills = [{ type: "SOLID", color: hexToRgb(bgHex) }];
	pillNode.horizontalPadding = pad;
	pillNode.verticalPadding = Math.round(pad * 0.5);
	pillNode.name = labelText;
	unsuppressNodeChanges([textNode.id, pillNode.id]);
}
