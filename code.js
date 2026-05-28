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
var suppressChangeFor = null;
var pendingRestoreData = null;

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
				if (suppressChangeFor === nodeId) continue;
				e.labelManuallyMoved = true;
				saveMeasuredLine(entryKeys[k], e);
			}
		}
	}
}

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
			});
		}
	}

	// ── Measure ──────────────────────────────────────────────
	if (msg.type === "measure") {
		var pxPerCm = msg.pxPerCm;
		var fontSize = msg.fontSize;
		var colorMode = msg.colorMode;
		var labelColor = msg.labelColor;
		var lineColor = msg.lineColor;
		var labelPlacement = msg.labelPlacement || "above";
		var selection = figma.currentPage.selection;

		if (selection.length === 0) {
			figma.ui.postMessage({ type: "error", text: "Select one or more vector lines first." });
			return;
		}

		await figma.loadFontAsync({ family: "Inter", style: "Bold" });
		saveGlobalScale(pxPerCm);

		var results = [];

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
			if (!node.strokeWeight || node.strokeWeight < 1) node.strokeWeight = 2;

			// Update existing
			if (measuredLines[node.id]) {
				var ex = measuredLines[node.id];
				var geomChanged = Math.abs(pathLength - ex.lastPathLength) > 0.5;
				ex.pxPerCm = usedScale;
				ex.labelColor = resolved.label;
				ex.lineColor = resolved.line;
				ex.fontSize = fontSize || 14;
				ex.labelPlacement = labelPlacement;
				ex.lastPathLength = pathLength;
				if (geomChanged) ex.labelManuallyMoved = false;

				try {
					var exLabel = await figma.getNodeByIdAsync(ex.pillId || ex.textId);
					if (exLabel) {
						await updateLabel(node, exLabel, ex, geomChanged || !ex.labelManuallyMoved);
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
				colorIndex: colorMode !== "manual" ? lineColorIndex - 1 : -1,
			};
			saveMeasuredLine(node.id, newEntry);
			results.push(labelText + (scaleInfo.source !== "global" ? " [" + scaleInfo.source + "]" : ""));
		}

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
		var sel = figma.currentPage.selection;
		if (sel.length === 0) {
			figma.ui.postMessage({ type: "scale-info", source: "global", name: null });
			return;
		}
		var globalScale = parseFloat(figma.root.getPluginData("globalScale")) || 0;
		var info = resolveScaleForNode(sel[0], globalScale);
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

		await figma.loadFontAsync({ family: "Inter", style: "Bold" });
		saveGlobalScale(pxPerCm);

		var count = 0;
		var keys = Object.keys(measuredLines);

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

					vNode.strokes = [{ type: "SOLID", color: hexToRgb(resolved.line) }];

					var newLen = getTotalPathLength(vNode);
					var geomChanged = Math.abs(newLen - entry.lastPathLength) > 0.5;
					if (geomChanged) {
						entry.lastPathLength = newLen;
						entry.labelManuallyMoved = false;
					}
					await updateLabel(vNode, lNode, entry, geomChanged || !entry.labelManuallyMoved);
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
		figma.ui.postMessage({ type: "result", text: "✓ Updated " + count + " line(s)" });
	}

	// ── Reset label position ──────────────────────────────────
	if (msg.type === "reset-label-position") {
		var sel = figma.currentPage.selection;
		for (var i = 0; i < sel.length; i++) {
			var entry = measuredLines[sel[i].id];
			if (entry) {
				try {
					var vNode = await figma.getNodeByIdAsync(sel[i].id);
					var lNode = await figma.getNodeByIdAsync(entry.pillId || entry.textId);
					if (vNode && lNode) {
						entry.labelManuallyMoved = false;
						await updateLabel(vNode, lNode, entry, true);
						saveMeasuredLine(sel[i].id, entry);
					}
				} catch (e) {}
			}
		}
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
			suppressChangeFor = pillOrText.id;
			await updatePill(pillOrText, textChild, labelText, entry.fontSize || 14, entry.labelColor);
			suppressChangeFor = null;
		}
		if (reposition) positionLabelParallel(vectorNode, pillOrText, entry.labelPlacement);
	} else {
		// Legacy plain text
		suppressChangeFor = pillOrText.id;
		await figma.loadFontAsync({ family: "Inter", style: "Bold" });
		pillOrText.characters = labelText;
		pillOrText.fontSize = entry.fontSize || 14;
		pillOrText.fills = [{ type: "SOLID", color: hexToRgb(entry.labelColor) }];
		if (reposition) positionLabelParallel(vectorNode, pillOrText, entry.labelPlacement);
		suppressChangeFor = null;
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
		segments.push({ s: s, e: e, ts: ts, te: te, len: len, curved: curved });
		totalLen += len;
	}

	var target = totalLen * 0.5;
	var walked = 0;
	var midPt = { x: 0, y: 0 };
	var tangent = { x: 1, y: 0 };

	for (var j = 0; j < segments.length; j++) {
		var item = segments[j];
		if (walked + item.len >= target || j === segments.length - 1) {
			var t = item.len > 0 ? (target - walked) / item.len : 0;
			t = Math.max(0, Math.min(1, t));
			if (item.curved) {
				var p0 = item.s;
				var p1 = { x: item.s.x + (item.ts ? item.ts.x : 0), y: item.s.y + (item.ts ? item.ts.y : 0) };
				var p2 = { x: item.e.x + (item.te ? item.te.x : 0), y: item.e.y + (item.te ? item.te.y : 0) };
				var p3 = item.e;
				var mt = 1 - t;
				midPt.x = mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x;
				midPt.y = mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y;
				tangent.x = 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x);
				tangent.y = 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y);
			} else {
				midPt.x = item.s.x + t * (item.e.x - item.s.x);
				midPt.y = item.s.y + t * (item.e.y - item.s.y);
				tangent.x = item.e.x - item.s.x;
				tangent.y = item.e.y - item.s.y;
			}
			break;
		}
		walked += item.len;
	}

	var angleRad = Math.atan2(tangent.y, tangent.x);
	var angleDeg = angleRad * (180 / Math.PI);
	var displayAngle = angleDeg;
	if (displayAngle > 90) displayAngle -= 180;
	if (displayAngle < -90) displayAngle += 180;

	// strokeWeight of the line (default 2 if not set)
	var strokeW = vectorNode.strokeWeight || 2;

	// labelH: pill height or text height — textNode is the pill frame
	var labelH = textNode.height || (textNode.fontSize || 14) * 1.6;

	var offsetDist;
	if (placement === "center") {
		// Place label exactly on the line — no perpendicular offset
		offsetDist = 0;
	} else {
		// Half the stroke + half the label height + 4px breathing room
		offsetDist = strokeW / 2 + labelH / 2 + 4;
		if (placement === "below") {
			// Flip perpendicular direction
			offsetDist = -offsetDist;
		}
	}

	var perpRad = angleRad - Math.PI / 2;

	suppressChangeFor = textNode.id;
	textNode.x = vectorNode.x + midPt.x + Math.cos(perpRad) * offsetDist - textNode.width / 2;
	textNode.y = vectorNode.y + midPt.y + Math.sin(perpRad) * offsetDist - textNode.height / 2;
	textNode.rotation = -displayAngle;
	suppressChangeFor = null;
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
	suppressChangeFor = textNode.id;
	suppressChangeFor = pillNode.id;
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
	suppressChangeFor = null;
}
