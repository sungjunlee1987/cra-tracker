import { useState, useRef } from "react";

// ── constants ────────────────────────────────────────────────
const ROLE_ORDER = ["PI", "Sub-I", "SC", "Lab technician", "Pharmacist", "Infusion nurse", "Other"];
const ROLE_COLORS = {
  "PI":             { bg: "#EEEDFE", color: "#3C3489" },
  "Sub-I":          { bg: "#E1F5EE", color: "#0F6E56" },
  "SC":             { bg: "#FAEEDA", color: "#854F0B" },
  "Lab technician": { bg: "#E6F1FB", color: "#0C447C" },
  "Pharmacist":     { bg: "#FAECE7", color: "#993C1D" },
  "Infusion nurse": { bg: "#FBEAF0", color: "#72243E" },
  "Other":          { bg: "#F1EFE8", color: "#5F5E5A" },
};

const TRAINING_PROMPT = `You are analyzing a clinical trial Training Log form.
This form may contain MULTIPLE trainees listed in an attendance table (Section B or similar).
Extract ONE record per trainee row.
- "site_number": numeric site code only (e.g. "0303" from "0303/ Dong-A University Hospital")
- "trainee_name": full name
- "role": role in study (PI, Sub-Investigator, CRC, SC, Pharmacist, etc.)
- "training_material": document title from Training Name/Document Details
- "version": version number (e.g. "v13.0"). Include "v" prefix.
- "training_date": DDMmmYYYY (e.g. "01Oct2025"). Dates may be handwritten.
- "trainer": trainer name, or "N/A"
- "status": "Completed" if signed, "Pending" if not
Return ONLY a JSON array, no markdown.`;

const DL_PROMPT = `You are analyzing a clinical trial Delegation Log.
Extract ALL staff members listed. For each person:
- "name_korean": Korean name or "N/A"
- "name_english": English/romanized name
- "role": map to one of: "PI","Sub-I","SC","Lab technician","Pharmacist","Infusion nurse","Other"
- "start_date": delegation start date DDMmmYYYY
- "end_date": delegation end date DDMmmYYYY, or "Ongoing"
- "tasks": delegated tasks as short comma-separated string, or "N/A"
Return ONLY a JSON array, no markdown.`;

// ── helpers ──────────────────────────────────────────────────
async function callAI(file, prompt) {
  const base64 = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => res(e.target.result.split(",")[1]);
    r.onerror = () => rej(new Error("파일 읽기 실패"));
    r.readAsDataURL(file);
  });
  const isPDF = file.type === "application/pdf" || file.name.endsWith(".pdf");
  const mediaType = isPDF ? "application/pdf" : (file.type || "image/jpeg");

  const resp = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 3000,
      system: "Extract structured data from clinical trial documents. Respond with ONLY valid JSON array. No markdown.",
      messages: [{ role: "user", content: [
        isPDF
          ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
          : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
        { type: "text", text: prompt }
      ]}]
    }),
  });
  if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error?.message || `HTTP ${resp.status}`); }
  const data = await resp.json();
  const raw = data.content.map(b => b.text || "").join("").trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeRole(r) {
  if (!r) return "Other";
  for (const k of ROLE_ORDER) if (r.toLowerCase().includes(k.toLowerCase())) return k;
  return "Other";
}

function matKey(r) {
  return `${r.training_material}${r.version && r.version !== "N/A" ? " " + r.version : ""}`;
}

// ── sub-components ───────────────────────────────────────────
function UploadZone({ onFiles, disabled, hasFiles }) {
  const [drag, setDrag] = useState(false);
  const ref = useRef();
  return (
    <div>
      <div
        onClick={() => !disabled && ref.current?.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
        style={{
          border: "2px dashed #d0d0d0", borderRadius: 12,
          padding: hasFiles ? "12px 16px" : "32px 16px",
          textAlign: "center", cursor: disabled ? "not-allowed" : "pointer",
          background: drag ? "#f0f0f0" : "#fafafa",
          transition: "background 0.15s",
        }}
      >
        {!hasFiles && <div style={{ fontSize: 36, marginBottom: 8 }}>📄</div>}
        <p style={{ fontSize: 14, color: "#666" }}>
          {hasFiles ? "+ 파일 추가 (클릭 또는 드래그)" : "PDF 또는 사진 업로드"}
        </p>
        {!hasFiles && <p style={{ fontSize: 12, color: "#999", marginTop: 4 }}>JPG · PNG · PDF · 여러 파일 동시 선택</p>}
      </div>
      <input ref={ref} type="file" accept="image/*,application/pdf" multiple style={{ display: "none" }} onChange={e => onFiles(e.target.files)} />
    </div>
  );
}

function FileList({ items, onRemove, analyzing }) {
  const sc = { pending: ["#f5f5f5","#888","대기"], analyzing: ["#FFF8E7","#854F0B","분석 중…"], done: ["#E8F8F0","#0F6E56","완료"], error: ["#FEF2F2","#A32D2D","오류"] };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
      {items.map((item, i) => {
        const [bg, col, label] = sc[item.status];
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, background: "#f5f5f5", borderRadius: 10, padding: "8px 12px" }}>
            <span style={{ fontSize: 20 }}>{item.file.name.endsWith(".pdf") ? "📕" : "🖼️"}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.file.name}</div>
              <div style={{ fontSize: 11, color: "#888" }}>{(item.file.size/1024).toFixed(0)} KB{item.status==="done"?` · ${item.rows.length}명`:""}</div>
            </div>
            <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: bg, color: col, whiteSpace: "nowrap", fontWeight: 500 }}>
              {item.status==="done"?"✓ ":item.status==="error"?"⚠️ ":""}{label}
            </span>
            {!analyzing && item.status !== "analyzing" && (
              <button onClick={() => onRemove(i)} style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#aaa", padding: "0 2px", lineHeight: 1 }}>×</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "12px 20px", fontSize: 14, fontWeight: 600, borderRadius: 12,
      border: "none", background: disabled ? "#ccc" : "#1a1a1a",
      color: "#fff", cursor: disabled ? "not-allowed" : "pointer", width: "100%",
    }}>{children}</button>
  );
}

function SecondaryButton({ onClick, children, style = {} }) {
  return (
    <button onClick={onClick} style={{
      padding: "10px 16px", fontSize: 13, borderRadius: 10,
      border: "1.5px solid #ddd", background: "#fff", cursor: "pointer", color: "#333", ...style
    }}>{children}</button>
  );
}

// ── TRAINING SECTION ─────────────────────────────────────────
function TrainingSection() {
  const [fileItems, setFileItems] = useState([]);
  const [reviewRows, setReviewRows] = useState([]);
  const [tracker, setTracker] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [expandPerson, setExpandPerson] = useState(null);
  const [duplicates, setDuplicates] = useState([]); // [{newRow, existingName, resolved: null}]
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);
  const [pendingRows, setPendingRows] = useState([]);

  function addFiles(list) {
    setFileItems(prev => [...prev, ...Array.from(list).map(f => ({ file: f, status: "pending", rows: [], error: null }))]);
  }

  async function analyzeAll() {
    setAnalyzing(true);
    const items = [...fileItems];
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === "done") continue;
      setFileItems(prev => prev.map((f, idx) => idx === i ? { ...f, status: "analyzing" } : f));
      try {
        const rows = await callAI(items[i].file, TRAINING_PROMPT);
        setFileItems(prev => prev.map((f, idx) => idx === i ? { ...f, status: "done", rows } : f));
        items[i] = { ...items[i], status: "done", rows };
      } catch (e) {
        setFileItems(prev => prev.map((f, idx) => idx === i ? { ...f, status: "error", error: e.message } : f));
        items[i] = { ...items[i], status: "error" };
      }
    }
    setReviewRows(items.flatMap(f => f.rows || []));
    setAnalyzing(false);
  }

  const [sheetStatus, setSheetStatus] = useState(null);

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({length: m+1}, (_, i) => Array.from({length: n+1}, (_, j) => i===0?j:j===0?i:0));
    for (let i=1;i<=m;i++) for (let j=1;j<=n;j++) dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
    return dp[m][n];
  }

  function findDuplicates(newRows, existingTracker) {
    const dupes = [];
    const existingNames = [...new Set(existingTracker.map(r => r.trainee_name))];
    for (const newRow of newRows) {
      const newName = newRow.trainee_name?.toLowerCase().trim() || '';
      for (const existName of existingNames) {
        const exName = existName?.toLowerCase().trim() || '';
        if (newName === exName) continue; // exact match = same person, no need to ask
        if (levenshtein(newName, exName) <= 3) {
          dupes.push({ newRow, existingName: existName, resolved: null });
          break;
        }
      }
    }
    return dupes;
  }

  async function doSave(rowsToSave) {
    setTracker(prev => [...prev, ...rowsToSave]);
    setReviewRows([]); setFileItems([]);
    setSheetStatus('saving');
    try {
      const resp = await fetch('/api/sheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rowsToSave }),
      });
      const data = await resp.json();
      if (data.success) setSheetStatus('saved');
      else throw new Error(data.error);
    } catch (e) {
      setSheetStatus('error');
    }
    setTimeout(() => setSheetStatus(null), 4000);
  }

  async function save() {
    const rowsToSave = [...reviewRows];
    const dupes = findDuplicates(rowsToSave, tracker);
    if (dupes.length > 0) {
      setDuplicates(dupes);
      setPendingRows(rowsToSave);
      setShowDuplicateModal(true);
    } else {
      await doSave(rowsToSave);
    }
  }

  async function resolveDuplicates() {
    // Apply merge decisions
    let finalRows = [...pendingRows];
    for (const dupe of duplicates) {
      if (dupe.resolved === true) {
        // Merge: rename new row to existing name
        finalRows = finalRows.map(r =>
          r.trainee_name === dupe.newRow.trainee_name
            ? { ...r, trainee_name: dupe.existingName }
            : r
        );
      }
      // If resolved === false, keep as separate person (no change)
    }
    setShowDuplicateModal(false);
    setDuplicates([]);
    setPendingRows([]);
    await doSave(finalRows);
  }

  // pivot
  const cols = [];
  tracker.forEach(r => { const k = matKey(r); if (!cols.includes(k)) cols.push(k); });
  const peopleMap = {};
  tracker.forEach(r => {
    const pk = `${r.site_number}||${r.trainee_name}`;
    if (!peopleMap[pk]) peopleMap[pk] = { site: r.site_number, name: r.trainee_name, role: r.role, trainings: {} };
    peopleMap[pk].trainings[matKey(r)] = { date: r.training_date, status: r.status };
  });
  const people = Object.values(peopleMap);

  const inReview = reviewRows.length > 0;

  return (
    <div>
      {/* Upload card */}
      <div style={{ background: "#fff", borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>📤 Training Log 업로드</div>
        {!analyzing && !inReview && <UploadZone onFiles={addFiles} disabled={analyzing} hasFiles={fileItems.length > 0} />}
        {fileItems.length > 0 && <FileList items={fileItems} onRemove={i => setFileItems(p => p.filter((_, idx) => idx !== i))} analyzing={analyzing} />}
        {fileItems.some(f => f.status === "error") && (
          <div style={{ background: "#FEF2F2", color: "#A32D2D", padding: "10px 14px", borderRadius: 10, fontSize: 12, marginTop: 10 }}>
            {fileItems.filter(f => f.status === "error").map((f, i) => <div key={i}>⚠️ {f.file.name}: {f.error}</div>)}
          </div>
        )}
        {!inReview && fileItems.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <SecondaryButton onClick={() => setFileItems([])} style={{ flex: 1 }}>초기화</SecondaryButton>
            <div style={{ flex: 2 }}>
              <PrimaryButton onClick={analyzeAll} disabled={analyzing}>
                {analyzing ? `⏳ 분석 중 (${fileItems.filter(f=>f.status==="done"||f.status==="error").length}/${fileItems.length})` : `✨ ${fileItems.length}개 파일 AI 분석`}
              </PrimaryButton>
            </div>
          </div>
        )}
      </div>

      {/* Sheet status toast */}
      {sheetStatus && (
        <div style={{ padding: "10px 14px", borderRadius: 10, marginBottom: 12, fontSize: 13, fontWeight: 500,
          background: sheetStatus === 'saved' ? '#E8F8F0' : sheetStatus === 'saving' ? '#FFF8E7' : '#FEF2F2',
          color: sheetStatus === 'saved' ? '#0F6E56' : sheetStatus === 'saving' ? '#854F0B' : '#A32D2D' }}>
          {sheetStatus === 'saving' ? '⏳ Google Sheets에 저장 중...' : sheetStatus === 'saved' ? '✅ Google Sheets에 저장됐어요!' : '⚠️ Sheets 저장 실패 (앱 내 데이터는 저장됨)'}
        </div>
      )}

      {/* Review */}
      {inReview && (
        <div style={{ background: "#fff", borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>✅ AI 추출 결과</div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>{reviewRows.length}명 인식됨 · 내용 확인 후 저장</div>
          {reviewRows.map((row, i) => (
            <div key={i} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 8, background: "#fafafa" }}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{row.trainee_name} <span style={{ fontWeight: 400, color: "#888", fontSize: 12 }}>{row.role}</span></div>
              {[["Site", "site_number"],["Material","training_material"],["Version","version"],["Date","training_date"],["Trainer","trainer"]].map(([label,key])=>(
                <div key={key} style={{ display: "flex", alignItems: "center", marginBottom: 4, gap: 8 }}>
                  <div style={{ fontSize: 11, color: "#888", width: 64, flexShrink: 0 }}>{label}</div>
                  <input value={row[key]||""} onChange={e => setReviewRows(p=>p.map((r,idx)=>idx===i?{...r,[key]:e.target.value}:r))}
                    style={{ flex: 1, fontSize: 13, border: "none", borderBottom: "1px solid #ddd", background: "transparent", padding: "2px 0", outline: "none" }} />
                </div>
              ))}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <SecondaryButton onClick={() => { setReviewRows([]); setFileItems([]); }} style={{ flex: 1 }}>취소</SecondaryButton>
            <div style={{ flex: 2 }}><PrimaryButton onClick={save}>📋 {reviewRows.length}명 저장</PrimaryButton></div>
          </div>
        </div>
      )}

      {/* Duplicate check modal */}
      {showDuplicateModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 20, padding: 24, maxWidth: 480, width: "100%", maxHeight: "80vh", overflowY: "auto" }}>
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 6 }}>⚠️ 동일 인물 확인</div>
            <div style={{ fontSize: 13, color: "#888", marginBottom: 20 }}>이름이 비슷한 인원이 있어요. 같은 사람인지 확인해주세요.</div>
            {duplicates.map((d, i) => (
              <div key={i} style={{ border: "1px solid #eee", borderRadius: 12, padding: 14, marginBottom: 12, background: "#fafafa" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ background: "#E8F8F0", color: "#0F6E56", padding: "4px 10px", borderRadius: 20, fontSize: 13, fontWeight: 600 }}>{d.existingName}</span>
                  <span style={{ fontSize: 13, color: "#aaa" }}>vs</span>
                  <span style={{ background: "#FFF8E7", color: "#854F0B", padding: "4px 10px", borderRadius: 20, fontSize: 13, fontWeight: 600 }}>{d.newRow.trainee_name}</span>
                </div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>같은 사람인가요?</div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => setDuplicates(prev => prev.map((x,idx) => idx===i ? {...x, resolved: true} : x))}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 600,
                      background: d.resolved === true ? "#1a1a1a" : "#f0f0f0",
                      color: d.resolved === true ? "#fff" : "#333", cursor: "pointer" }}>
                    ✓ 같은 사람 (합치기)
                  </button>
                  <button
                    onClick={() => setDuplicates(prev => prev.map((x,idx) => idx===i ? {...x, resolved: false} : x))}
                    style={{ flex: 1, padding: "8px 0", borderRadius: 10, border: "none", fontSize: 13, fontWeight: 600,
                      background: d.resolved === false ? "#1a1a1a" : "#f0f0f0",
                      color: d.resolved === false ? "#fff" : "#333", cursor: "pointer" }}>
                    ✗ 다른 사람 (따로 추가)
                  </button>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={() => { setShowDuplicateModal(false); setDuplicates([]); setPendingRows([]); }}
                style={{ flex: 1, padding: "10px 0", borderRadius: 12, border: "1px solid #ddd", background: "#fff", fontSize: 13, cursor: "pointer" }}>
                취소
              </button>
              <button
                onClick={resolveDuplicates}
                disabled={duplicates.some(d => d.resolved === null)}
                style={{ flex: 2, padding: "10px 0", borderRadius: 12, border: "none", fontSize: 13, fontWeight: 600,
                  background: duplicates.some(d => d.resolved === null) ? "#ccc" : "#1a1a1a",
                  color: "#fff", cursor: duplicates.some(d => d.resolved === null) ? "not-allowed" : "pointer" }}>
                {duplicates.some(d => d.resolved === null) ? "모두 선택해주세요" : "확인 완료 → 저장"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pivot tracker */}
      <div style={{ background: "#fff", borderRadius: 16, padding: 16, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>📊 Training Tracker</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "#888" }}>{people.length}명 · {cols.length}개</span>
            {tracker.length > 0 && <SecondaryButton onClick={() => setTracker([])} style={{ padding: "4px 10px", fontSize: 11 }}>초기화</SecondaryButton>}
          </div>
        </div>

        {tracker.length === 0 ? (
          <div style={{ textAlign: "center", color: "#aaa", padding: "2rem", fontSize: 13 }}>업로드 후 Tracker가 여기에 표시됩니다</div>
        ) : (
          <div>
            {people.map((p, i) => (
              <div key={i} style={{ border: "1px solid #eee", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
                <div onClick={() => setExpandPerson(expandPerson === i ? null : i)}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", cursor: "pointer", background: i % 2 === 0 ? "#fafafa" : "#fff" }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: "#888", marginLeft: 6 }}>{p.role} · {p.site}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 12, color: "#0F6E56" }}>{Object.keys(p.trainings).length}/{cols.length}</span>
                    <span style={{ fontSize: 12, color: "#aaa" }}>{expandPerson === i ? "▲" : "▼"}</span>
                  </div>
                </div>
                {expandPerson === i && (
                  <div style={{ padding: "10px 14px", borderTop: "1px solid #f0f0f0" }}>
                    {cols.map(col => {
                      const t = p.trainings[col];
                      return (
                        <div key={col} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}>
                          <div style={{ fontSize: 13, flex: 1 }}>{col}</div>
                          {t ? (
                            <div style={{ textAlign: "right" }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: t.status==="Completed"?"#0F6E56":"#854F0B" }}>{t.status==="Completed"?"✓ 완료":"○ 미완"}</div>
                              <div style={{ fontSize: 11, color: "#888" }}>{t.date}</div>
                            </div>
                          ) : <span style={{ fontSize: 13, color: "#ccc" }}>—</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── STAFF SECTION ─────────────────────────────────────────────
function StaffSection() {
  const [fileItems, setFileItems] = useState([]);
  const [reviewRows, setReviewRows] = useState([]);
  const [staff, setStaff] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [expandedRoles, setExpandedRoles] = useState({});
  const [expandedPerson, setExpandedPerson] = useState(null);

  function addFiles(list) {
    setFileItems(prev => [...prev, ...Array.from(list).map(f => ({ file: f, status: "pending", rows: [], error: null }))]);
  }

  async function analyzeAll() {
    setAnalyzing(true);
    const items = [...fileItems];
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === "done") continue;
      setFileItems(prev => prev.map((f, idx) => idx === i ? { ...f, status: "analyzing" } : f));
      try {
        const rows = await callAI(items[i].file, DL_PROMPT);
        setFileItems(prev => prev.map((f, idx) => idx === i ? { ...f, status: "done", rows } : f));
        items[i] = { ...items[i], status: "done", rows };
      } catch (e) {
        setFileItems(prev => prev.map((f, idx) => idx === i ? { ...f, status: "error", error: e.message } : f));
        items[i] = { ...items[i], status: "error" };
      }
    }
    setReviewRows(items.flatMap(f => f.rows || []));
    setAnalyzing(false);
  }

  function save() {
    const updated = [...staff];
    for (const row of reviewRows) {
      const key = row.name_english?.trim().toLowerCase();
      const idx = updated.findIndex(s => s.name_english?.trim().toLowerCase() === key);
      const normalized = { ...row, role: normalizeRole(row.role) };
      if (idx >= 0) updated[idx] = { ...updated[idx], ...normalized };
      else updated.push(normalized);
    }
    setStaff(updated);
    setReviewRows([]); setFileItems([]);
  }

  const groups = {};
  for (const r of ROLE_ORDER) groups[r] = [];
  staff.forEach(s => groups[normalizeRole(s.role)].push(s));
  const inReview = reviewRows.length > 0;

  return (
    <div>
      {/* Upload */}
      <div style={{ background: "#fff", borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>📤 Delegation Log 업로드</div>
        {!analyzing && !inReview && <UploadZone onFiles={addFiles} disabled={analyzing} hasFiles={fileItems.length > 0} />}
        {fileItems.length > 0 && <FileList items={fileItems} onRemove={i => setFileItems(p => p.filter((_, idx) => idx !== i))} analyzing={analyzing} />}
        {!inReview && fileItems.length > 0 && (
          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <SecondaryButton onClick={() => setFileItems([])} style={{ flex: 1 }}>초기화</SecondaryButton>
            <div style={{ flex: 2 }}>
              <PrimaryButton onClick={analyzeAll} disabled={analyzing}>
                {analyzing ? `⏳ (${fileItems.filter(f=>f.status==="done"||f.status==="error").length}/${fileItems.length})` : `✨ ${fileItems.length}개 AI 분석`}
              </PrimaryButton>
            </div>
          </div>
        )}
      </div>

      {/* Review */}
      {inReview && (
        <div style={{ background: "#fff", borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>✅ AI 추출 결과</div>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>{reviewRows.length}명 인식됨 · 확인 후 저장</div>
          {reviewRows.map((row, i) => (
            <div key={i} style={{ border: "1px solid #eee", borderRadius: 10, padding: 12, marginBottom: 8, background: "#fafafa" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{row.name_english}</span>
                  {row.name_korean && row.name_korean !== "N/A" && <span style={{ fontSize: 12, color: "#888", marginLeft: 6 }}>{row.name_korean}</span>}
                </div>
                <button onClick={() => setReviewRows(p => p.filter((_,idx)=>idx!==i))} style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "#aaa" }}>×</button>
              </div>
              {[["역할","role"],["Start","start_date"],["End","end_date"],["Tasks","tasks"]].map(([label,key])=>(
                <div key={key} style={{ display: "flex", alignItems: "center", marginBottom: 4, gap: 8 }}>
                  <div style={{ fontSize: 11, color: "#888", width: 48, flexShrink: 0 }}>{label}</div>
                  <input value={row[key]||""} onChange={e=>setReviewRows(p=>p.map((r,idx)=>idx===i?{...r,[key]:e.target.value}:r))}
                    style={{ flex: 1, fontSize: 13, border: "none", borderBottom: "1px solid #ddd", background: "transparent", padding: "2px 0", outline: "none" }} />
                </div>
              ))}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8 }}>
            <SecondaryButton onClick={() => { setReviewRows([]); setFileItems([]); }} style={{ flex: 1 }}>취소</SecondaryButton>
            <div style={{ flex: 2 }}><PrimaryButton onClick={save}>👥 {reviewRows.length}명 저장</PrimaryButton></div>
          </div>
        </div>
      )}

      {/* Staff list */}
      {staff.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 16, padding: 32, textAlign: "center", color: "#aaa", fontSize: 13, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
          Delegation Log를 업로드하면<br />역할별 Staff 목록이 표시됩니다
        </div>
      ) : (
        <>
          {/* Summary chips */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {ROLE_ORDER.filter(r => groups[r].length > 0).map(r => {
              const rc = ROLE_COLORS[r];
              return (
                <div key={r} onClick={() => setExpandedRoles(p => ({ ...p, [r]: !p[r] }))}
                  style={{ background: rc.bg, color: rc.color, borderRadius: 20, padding: "6px 14px", fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
                  {r} {groups[r].length}명
                </div>
              );
            })}
          </div>

          {ROLE_ORDER.filter(r => groups[r].length > 0).map(role => {
            const rc = ROLE_COLORS[role];
            const isOpen = expandedRoles[role] !== false;
            return (
              <div key={role} style={{ background: "#fff", borderRadius: 16, marginBottom: 10, overflow: "hidden", boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
                <div onClick={() => setExpandedRoles(p => ({ ...p, [role]: !isOpen }))}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: rc.bg, cursor: "pointer" }}>
                  <span style={{ fontWeight: 600, color: rc.color, fontSize: 14 }}>{role} <span style={{ fontWeight: 400, fontSize: 12 }}>{groups[role].length}명</span></span>
                  <span style={{ color: rc.color, fontSize: 12 }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && groups[role].map((s, i) => {
                  const pk = `${role}||${s.name_english}`;
                  const open = expandedPerson === pk;
                  const ongoing = !s.end_date || s.end_date === "Ongoing" || s.end_date === "N/A";
                  return (
                    <div key={i} style={{ borderTop: "1px solid #f0f0f0" }}>
                      <div onClick={() => setExpandedPerson(open ? null : pk)}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", cursor: "pointer", background: i%2===0?"#fff":"#fafafa" }}>
                        <div>
                          <div style={{ fontWeight: 500, fontSize: 14 }}>{s.name_english}</div>
                          {s.name_korean && s.name_korean !== "N/A" && <div style={{ fontSize: 12, color: "#888" }}>{s.name_korean}</div>}
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: ongoing?"#E8F8F0":"#f0f0f0", color: ongoing?"#0F6E56":"#666", display: "inline-block" }}>
                            {ongoing ? "Ongoing" : s.end_date}
                          </div>
                          <div style={{ fontSize: 10, color: "#aaa", marginTop: 2 }}>{open?"▲":"▼"}</div>
                        </div>
                      </div>
                      {open && (
                        <div style={{ padding: "10px 16px 14px", background: "#f9f9f9", borderTop: "1px solid #f0f0f0" }}>
                          {[["Start Date", s.start_date],["End Date", s.end_date||"Ongoing"],["Tasks", s.tasks]].map(([label,val])=>(
                            <div key={label} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                              <div style={{ fontSize: 11, color: "#888", width: 72, flexShrink: 0, paddingTop: 1 }}>{label}</div>
                              <div style={{ fontSize: 13 }}>{val || "—"}</div>
                            </div>
                          ))}
                          <button onClick={() => setStaff(p => p.filter(x => x.name_english !== s.name_english))}
                            style={{ marginTop: 4, fontSize: 12, padding: "4px 12px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#888" }}>삭제</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
          <div style={{ textAlign: "right", marginTop: 4 }}>
            <SecondaryButton onClick={() => setStaff([])} style={{ fontSize: 12, padding: "5px 14px" }}>전체 초기화</SecondaryButton>
          </div>
        </>
      )}
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("training");
  const TABS = [
    { id: "training", label: "🗒️ Training" },
    { id: "staff",    label: "👥 Staff" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f5" }}>
      {/* Top bar */}
      <div style={{ background: "#fff", padding: "14px 16px 0", boxShadow: "0 1px 0 #eee", position: "sticky", top: 0, zIndex: 10 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>🤖 CRA Tracker</div>
        <div style={{ display: "flex", gap: 0 }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              flex: 1, padding: "10px 0", fontSize: 13, fontWeight: tab===t.id?600:400,
              borderBottom: tab===t.id?"2.5px solid #1a1a1a":"2.5px solid transparent",
              background: "none", border: "none", borderBottom: tab===t.id?"2.5px solid #1a1a1a":"2.5px solid transparent",
              color: tab===t.id?"#1a1a1a":"#999", cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: "16px 14px 80px", maxWidth: 520, margin: "0 auto" }}>
        {tab === "training" && <TrainingSection />}
        {tab === "staff"    && <StaffSection />}
      </div>
    </div>
  );
}
