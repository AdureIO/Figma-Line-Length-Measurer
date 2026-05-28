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
var DEFAULT_UI_SETTINGS = {
	colorMode: "auto-dark",
	lineColor: "#ff5500",
	labelColor: "#ff5500",
	fontSize: 14,
	labelPlacement: "above",
	lineWidth: 8,
};

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
	};
	figma.root.setPluginData("uiSettings", JSON.stringify(safe));
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

async function init() {
	// 1. Restore global scale from document root
	var savedScale = figma.root.getPluginData("globalScale");
	var savedIndex = figma.root.getPluginData("lineColorIndex");
	if (savedIndex) lineColorIndex = parseInt(savedIndex) || 0;

	// 2. Restore tracked lines — stored as a JSON index on the root
	var savedIndex2 = figma.root.getPluginData("measuredLinesIndex");
	if (savedIndex2) {
		try {
			var index = JSON.parse(savedIndex2); // array of nodeIds
			for (var i = 0; i < index.length; i++) {
				var nodeId = index[i];
				try {
					var node = await figma.getNodeByIdAsync(nodeId);
					if (node && node.type === "VECTOR") {
						var raw = node.getPluginData("lineEntry");
						if (raw) {
							var entry = JSON.parse(raw);
							measuredLines[nodeId] = entry;
						}
					}
				} catch (e) {
					/* node deleted, skip */
				}
			}
		} catch (e) {}
	}

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
	measuredLines[nodeId] = entry;
	// Save entry on the vector node itself
	try {
		figma.getNodeByIdAsync(nodeId).then(function (node) {
			if (node) node.setPluginData("lineEntry", JSON.stringify(entry));
		});
	} catch (e) {}
	// Update root index
	saveMeasuredLinesIndex();
}

function removeMeasuredLine(nodeId) {
	delete measuredLines[nodeId];
	try {
		figma.getNodeByIdAsync(nodeId).then(function (node) {
			if (node) node.setPluginData("lineEntry", "");
		});
	} catch (e) {}
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
	var raw = figma.root.getPluginData("nodeScalesIndex");
	var index = [];
	try {
		index = raw ? JSON.parse(raw) : [];
	} catch (e) {
		return [];
	}

	// Always read pxPerCm live from the node itself — never trust the stale index value
	var result = [];
	var cleanIndex = [];
	for (var i = 0; i < index.length; i++) {
		try {
			var n = await figma.getNodeByIdAsync(index[i].id);
			if (n) {
				var livePx = parseFloat(n.getPluginData("nodeScale"));
				if (livePx > 0) {
					result.push({ id: index[i].id, name: n.name, pxPerCm: livePx });
					cleanIndex.push({ id: index[i].id, name: n.name, pxPerCm: livePx });
				}
			}
			// node deleted — drop from index silently
		} catch (e) {}
	}
	// Write back cleaned index (removes deleted nodes)
	figma.root.setPluginData("nodeScalesIndex", JSON.stringify(cleanIndex));

	// Prepend global — always read live from root
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
}

figma.on("selectionchange", function () {
	postSelectionScaleInfo();
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
	}

	if (msg.type === "save-settings") {
		saveUiSettings(msg.settings || {});
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
							formatLength(pathLength / usedScale) +
								(scaleInfo.source !== "global" ? " [" + scaleInfo.source + "]" : ""),
						);
						continue;
					}
				} catch (e2) {}
			}

			// New line
			if (colorMode !== "manual") lineColorIndex++;
			saveLineColorIndex();

			var labelText = formatLength(pathLength / usedScale);

			// Keep the original parent so the line stays in its frame/group
			var originalParent = node.parent || figma.currentPage;
			var groupParent = originalParent.type === "PAGE" ? figma.currentPage : originalParent;

			// Create pill label
			var pillResult = await createPill(labelText, fontSize || 14, resolved.label);
			var pill = pillResult.pill;
			var text = pillResult.text;

			groupParent.appendChild(pill);
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
				colorIndex: colorMode !== "manual" ? lineColorIndex - 1 : -1,
			};
			saveMeasuredLine(node.id, newEntry);
			results.push(labelText + (scaleInfo.source !== "global" ? " [" + scaleInfo.source + "]" : ""));
		}
		await relaxMovableLabelOverlaps(movedLabelIds, 3);

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
						if (grp) grp.name = "Line: " + formatLength(newLen / entry.pxPerCm);
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
		figma.ui.postMessage({ type: "result", text: "✓ Label position reset" });
	}
};

// ── Update label ──────────────────────────────────────────────────────────────

async function updateLabel(vectorNode, pillOrText, entry, reposition) {
	var totalCm = getTotalPathLength(vectorNode) / entry.pxPerCm;
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
