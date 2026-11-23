import { Textarea } from '@blain-projects/ui';
import { Header, BlueprintBackground, ThemeToggle, useTheme, Button, Input, Drawer } from '@blain-projects/ui';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Label, Legend
} from 'recharts';
import {
  Settings, Download, Disc3, CircleHelp, Box, Waypoints, Spline, Anchor, PenLine,
  SlidersHorizontal, Eye, ChartLine, MoreHorizontal
} from 'lucide-react';
import StlExportModal from './StlExportModal';
import { motion, AnimatePresence, MotionConfig } from 'framer-motion';
import type { SimulationParams, SimulationResult } from './components';
import {
  ParameterSlider, StatRow, Accordion, AccordionScope, TooltipHintsProvider, ClosureRampToggle, CamProfilePreview,
  apiFetch, defaultParams, mergeConfigParams,
} from './components';
import { ProfileImportModal, ProfilePill, ProfileSaveDialog } from './ProfileControls';
import { UNSAVED_PROFILE, createProfile, getDefaultProfile, getProfile, listProfiles, profileTypeOf, saveProfile, suggestNextProfileName } from './lib/profiles';
import type { ProfileHandle, ProfilePayload, ProfileState, ProfileType, StoredProfile } from './lib/profiles';
import { CamSchematicCard } from './CamSchematic';
import { interpAt, useCamTravel } from './lib/camTravel';
import type { ChartDomainSettings } from './components';
import { ChartCard } from './ChartCard';
import { TubeModelControls, TubeSectionCard } from './TubeModel';
import { chartDomain } from './lib/chartDomain';
import type { ChartCardView } from './ChartCard';
import ProfileBuilder, { FinderProfilePreview } from './ProfileBuilder';
import LinkageExplorer, { LinkageProfilePreview } from './LinkageExplorer';
import CompliantBars, { CompliantProfilePreview } from './CompliantBars';
import { SubTabs } from './SubTabs';
import type { SubTab } from './SubTabs';
import {
  explorerMotorSpeed,
  explorerDefaultDist,
  explorerThickness,
  explorerHeight,
  explorerK,
  explorerDeadband,
  explorerTubeId,
  explorerTubeOd,
  explorerPressure,
  explorerCompliance,
  explorerChamberVol,
} from './parameterTooltips';

type ExplorerChartKey = 'pneumatic' | 'gapY' | 'gapTime' | 'section';

// Memoised: it stays mounted behind the other tabs and should not follow every App render.
const KeptProfileBuilder = React.memo(ProfileBuilder);

type TopTab = 'cam' | 'linkage' | 'lever' | 'pendulum' | 'compliant';
type MobilePane = 'controls' | 'schematic' | 'charts';
const TOP_TABS: TopTab[] = ['cam', 'linkage', 'lever', 'pendulum', 'compliant'];
const MOBILE_PANES: { id: MobilePane; label: string; Icon: typeof SlidersHorizontal }[] = [
  { id: 'controls', label: 'Controls', Icon: SlidersHorizontal },
  { id: 'schematic', label: 'Schematic', Icon: Eye },
  { id: 'charts', label: 'Charts', Icon: ChartLine },
];
const TABS_KEY = 'cam-sim.tabs.v1';
const SUB_TABS: { value: SubTab; label: string }[] = [{ value: 'explorer', label: 'Explorer' }, { value: 'finder', label: 'Finder' }];
const SOLVER_SUB_TABS: { value: SubTab; label: string }[] = [{ value: 'explorer', label: 'Explorer' }, { value: 'finder', label: 'Solver' }];
const DEFAULT_SUB_TABS: Record<TopTab, SubTab> = { cam: 'explorer', linkage: 'explorer', lever: 'explorer', pendulum: 'explorer', compliant: 'explorer' };

/** A stored cam profile's parameters, its note column over the payload's note as the old route served it. */
function camParamsFromProfile(payload: Record<string, unknown>, note: string): SimulationParams {
  return mergeConfigParams('note' in payload || note ? { ...payload, note } : payload);
}

const renderProfilePreview = (type: ProfileType) => (payload: ProfilePayload) =>
  type === 'cam' ? <CamProfilePreview payload={payload} />
    : type === 'cam-finder' ? <FinderProfilePreview payload={payload} />
      : type === 'compliant' ? <CompliantProfilePreview payload={payload} />
        : <LinkageProfilePreview kind={type} payload={payload} />;

function loadTabs(): { tab: TopTab; sub: Record<TopTab, SubTab> } {
  const sub = { ...DEFAULT_SUB_TABS };
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      for (const t of TOP_TABS) if (raw.sub?.[t] === 'explorer' || raw.sub?.[t] === 'finder') sub[t] = raw.sub[t];
      if (TOP_TABS.includes(raw.tab)) return { tab: raw.tab, sub };
    }
  } catch { /* storage unavailable or corrupt: defaults */ }
  return { tab: 'cam', sub };
}

function interpolateAlongY(yMm: number, ys: number[], vals: number[]): number | null {
  const n = ys.length;
  if (n === 0 || n !== vals.length) return null;
  if (n === 1) return vals[0];
  for (let i = 0; i < n - 1; i++) {
    const a = ys[i], b = ys[i + 1];
    if (a === b) continue;
    if ((yMm - a) * (yMm - b) <= 0) {
      const t = (yMm - a) / (b - a);
      return vals[i] + t * (vals[i + 1] - vals[i]);
    }
  }
  let bi = 0;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(ys[i] - yMm);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  }
  return vals[bi];
}

export default function App() {
  const { theme, setTheme } = useTheme();
  const [initialTabs] = useState(loadTabs);
  const [activeTab, setActiveTab] = useState<TopTab>(initialTabs.tab);
  const [subTabs, setSubTabs] = useState<Record<TopTab, SubTab>>(initialTabs.sub);
  const subTab = subTabs[activeTab];
  const setSubTab = useCallback((tab: TopTab, sub: SubTab) => setSubTabs((s) => ({ ...s, [tab]: sub })), []);
  const camExplorer = activeTab === 'cam' && subTab === 'explorer';
  const camFinder = activeTab === 'cam' && subTab === 'finder';
  // Mounted on the first visit, then only hidden, so a solve in progress survives switching tabs.
  const [builderMounted, setBuilderMounted] = useState(camFinder);
  useEffect(() => { if (camFinder) setBuilderMounted(true); }, [camFinder]);
  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify({ tab: activeTab, sub: subTabs })); } catch { /* ignore */ }
  }, [activeTab, subTabs]);
  const [params, setParams] = useState<SimulationParams>(defaultParams);
  const [savedParams, setSavedParams] = useState<SimulationParams | null>(null);
  const [data, setData] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The loaded cam profile; null when nothing saved is loaded. */
  const [activeConfigName, setActiveConfigName] = useState<string | null>(null);
  /** The profile type the import window lists, fixed when it opens; null when it is closed. */
  const [importType, setImportType] = useState<ProfileType | null>(null);
  /** What the save dialog saves, fixed when it opens: switching tab behind it cannot change the type, the feature or the name. */
  const [saveTarget, setSaveTarget] = useState<{ type: ProfileType; handle: ProfileHandle; loaded: string | null; note: string } | null>(null);
  /** The Cam Finder and the open linkage tab report their profile here; the header pill acts on them through the refs. */
  const [finderProfile, setFinderProfile] = useState<ProfileState>(UNSAVED_PROFILE);
  /** Tagged with its type: the state a closed linkage tab reported never shows on another one. */
  const [linkageProfile, setLinkageProfile] = useState<{ type: ProfileType; state: ProfileState } | null>(null);
  const [compliantProfile, setCompliantProfile] = useState<ProfileState>(UNSAVED_PROFILE);
  const finderRef = useRef<ProfileHandle>(null);
  const linkageRef = useRef<ProfileHandle>(null);
  const compliantRef = useRef<ProfileHandle>(null);
  const [guidanceMode, setGuidanceMode] = useState(true);
  const [toast, setToast] = useState<{ message: string; visible: boolean }>({ message: '', visible: false });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const simulateAbortRef = useRef<AbortController | null>(null);
  const [detailsView, setDetailsView] = useState(false);
  const travel = useCamTravel(data);
  const [showStlExport, setShowStlExport] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('controls');
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);

  const getExplorerChartSettings = useCallback((key: ExplorerChartKey): ChartDomainSettings => {
    const root = (params.chart_settings ?? {}) as Record<string, unknown>;
    const explorer = (root.explorer ?? {}) as Record<string, unknown>;
    const raw = explorer[key] as Partial<ChartDomainSettings> | undefined;
    const fallback: Record<ExplorerChartKey, ChartDomainSettings> = {
      pneumatic: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 25 },
      gapY: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 2 },
      gapTime: { autoX: true, autoY: true, xMin: 0, xMax: 100, yMin: 0, yMax: 2 },
      section: { autoX: true, autoY: true, xMin: -2.5, xMax: 2.5, yMin: -2, yMax: 2 },
    };
    return {
      ...fallback[key],
      ...(raw ?? {}),
    };
  }, [params.chart_settings]);

  const setExplorerChartSettings = useCallback((key: ExplorerChartKey, next: ChartDomainSettings) => {
    setParams((prev) => {
      const root = (prev.chart_settings ?? {}) as Record<string, unknown>;
      const explorer = (root.explorer ?? {}) as Record<string, unknown>;
      return {
        ...prev,
        chart_settings: {
          ...root,
          explorer: {
            ...explorer,
            [key]: next,
          },
        },
      };
    });
  }, []);

  const isExplorerChartSettingsModified = useCallback((key: ExplorerChartKey) => {
    if (!savedParams) return false;
    const cur = getExplorerChartSettings(key);
    const savedRoot = (savedParams.chart_settings ?? {}) as Record<string, unknown>;
    const savedExplorer = (savedRoot.explorer ?? {}) as Record<string, unknown>;
    const fallback: Record<ExplorerChartKey, ChartDomainSettings> = {
      pneumatic: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 25 },
      gapY: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 2 },
      gapTime: { autoX: true, autoY: true, xMin: 0, xMax: 100, yMin: 0, yMax: 2 },
      section: { autoX: true, autoY: true, xMin: -2.5, xMax: 2.5, yMin: -2, yMax: 2 },
    };
    const saved = { ...fallback[key], ...((savedExplorer[key] as Partial<ChartDomainSettings> | undefined) ?? {}) };
    return JSON.stringify(cur) !== JSON.stringify(saved);
  }, [savedParams, getExplorerChartSettings]);

  const showToast = (message: string) => {
    setToast({ message, visible: true });
    setTimeout(() => setToast({ message: '', visible: false }), 3000);
  };

  // Cross-tab: apply params from Profile Builder
  // Stable, so the kept-alive builder does not re-render while hidden.
  const handleApplyFromBuilder = useCallback((builderParams: SimulationParams) => {
    setParams(builderParams);
    setSavedParams(null);
    setActiveConfigName(null);
    setActiveTab('cam');
    setSubTab('cam', 'explorer');
    setMobilePane('schematic');
    setToast({ message: 'Profile applied from Builder', visible: true });
    setTimeout(() => setToast({ message: '', visible: false }), 3000);
  }, [setSubTab]);

  const handleShowMobileResults = useCallback(() => {
    setMobilePane('schematic');
  }, []);

  const applyCamProfile = (p: StoredProfile) => {
    const merged = camParamsFromProfile(p.payload, p.note);
    setParams(merged);
    setSavedParams(merged);
    setActiveConfigName(p.name);
  };

  useEffect(() => {
    (async () => {
      try {
        const name = await getDefaultProfile('cam');
        if (!name) return;
        applyCamProfile(await getProfile('cam', name));
        showToast(`Startup profile loaded: ${name}`);
      } catch (err) {
        console.error('Error loading default config:', err);
      }
    })();
  }, []);
  const handleLoadConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        const merged = mergeConfigParams(json);
        setParams(merged);
        setSavedParams(merged);
        // The file is not the loaded profile: Update must not overwrite that profile with it.
        setActiveConfigName(null);
      } catch (err) {
        console.error('Failed to parse JSON:', err);
        alert('Invalid JSON file');
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const fetchSimulation = useCallback(async (currentParams: SimulationParams) => {
    simulateAbortRef.current?.abort();
    const ac = new AbortController();
    simulateAbortRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/api/simulate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentParams),
        signal: ac.signal,
      });
      if (response.status === 422) {
        // The model refused these inputs (for example the FEM tube balloons at this pressure): say why.
        const body = await response.json().catch(() => null);
        if (typeof body?.detail === 'string') { setError(body.detail); return; }
      }
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const result = await response.json();
      setData(result);
    } catch (e: unknown) {
      const aborted = (e instanceof DOMException && e.name === 'AbortError')
        || (e instanceof Error && e.name === 'AbortError');
      if (aborted) return;
      console.error('Failed to fetch simulation:', e);
      setError('Failed to connect to backend. Is the FastAPI server running?');
    } finally {
      if (simulateAbortRef.current === ac) {
        setLoading(false);
        simulateAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { fetchSimulation(params); }, 100);
    return () => clearTimeout(timer);
  }, [params, fetchSimulation]);

  useEffect(() => () => {
    simulateAbortRef.current?.abort();
  }, []);

  const handleParamChange = (key: Exclude<keyof SimulationParams, 'note'>, value: number | boolean) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const handleNoteChange = (value: string) => {
    setParams(prev => ({ ...prev, note: value }));
  };

  const hasChanges = useMemo(() => savedParams ? JSON.stringify(params) !== JSON.stringify(savedParams) : false, [params, savedParams]);

  // ─── Saved profiles: one pill, one import window, one save dialog for every tab ───
  const profileType = profileTypeOf(activeTab, subTab);
  const profileTypeRef = useRef(profileType);
  useEffect(() => { profileTypeRef.current = profileType; }, [profileType]);
  const camProfile: ProfileState = { name: activeConfigName, dirty: hasChanges, canSave: true, note: params.note };
  const camHandle: ProfileHandle = {
    type: 'cam',
    getPayload: (note) => ({ ...params, note }),
    apply: applyCamProfile,
    markSaved: (name, note, payload) => {
      setActiveConfigName(name);
      setParams((prev) => ({ ...prev, note }));
      setSavedParams(payload as unknown as SimulationParams);
    },
    detach: () => { setActiveConfigName(null); setSavedParams(null); },
  };
  const profileState = camExplorer ? camProfile
    : camFinder ? finderProfile
    : activeTab === 'compliant' ? compliantProfile
    : linkageProfile?.type === profileType ? linkageProfile.state : UNSAVED_PROFILE;
  /** The open feature's handle, only when it saves the open context's type. */
  const profileHandle = (): ProfileHandle | null => {
    const handle = camExplorer ? camHandle
      : camFinder ? finderRef.current
      : activeTab === 'compliant' ? compliantRef.current
      : linkageRef.current;
    return handle && handle.type === profileType ? handle : null;
  };

  /** Store the open feature's payload; an empty name is generated by the server (cam and Cam Finder only). */
  const saveAsNew = async (type: ProfileType, handle: ProfileHandle | null, name: string, note: string) => {
    if (!handle || handle.type !== type) throw new Error('the open tab changed, nothing was saved');
    if (name) {
      const { profiles } = await listProfiles(type);
      if (profiles.some((p) => p.name === name) && !confirm(`A saved profile is already named "${name}". Overwrite it?`)) return false;
    }
    const payload = handle.getPayload(note);
    const out = name ? await saveProfile(type, name, payload, note) : await createProfile(type, payload, note);
    handle.markSaved(out.name, note, payload);
    showToast(out.status === 'updated' ? `Profile ${out.name} updated` : `Profile ${out.name} saved`);
    return true;
  };

  /** Overwrite the loaded profile, keeping its stored note when the feature has no note field. */
  const updateProfile = async () => {
    const type = profileType;
    const handle = profileHandle();
    const name = profileState.name;
    if (!handle || !name) return;
    try {
      // A feature without a note field keeps the stored note; if it cannot be read, nothing is written.
      const note = profileState.note ?? (await getProfile(type, name)).note;
      const payload = handle.getPayload(note);
      await saveProfile(type, name, payload, note);
      handle.markSaved(name, note, payload);
      showToast(`Profile ${name} updated`);
    } catch (err) {
      showToast(`Not saved: ${err instanceof Error ? err.message : err}`);
    }
  };

  /** Reload the loaded profile from the store, discarding unsaved edits. */
  const revertProfile = async () => {
    const type = profileType;
    const handle = profileHandle();
    const name = profileState.name;
    if (!handle || !name) return;
    try {
      const saved = await getProfile(type, name);
      if (profileTypeRef.current !== type) return;
      handle.apply(saved);
      showToast(`Reverted to ${name}`);
    } catch (err) {
      showToast(`Could not revert: ${err instanceof Error ? err.message : err}`);
    }
  };

  const openSaveDialog = async () => {
    const handle = profileHandle();
    if (!handle) return;
    const { name, note } = profileState;
    let initial = note ?? '';
    // A linkage tab has no note field: start from the loaded profile's note so saving over it does not blank it.
    if (note === undefined && name) initial = (await getProfile(handle.type, name).catch(() => null))?.note ?? '';
    setSaveTarget({ type: handle.type, handle, loaded: name, note: initial });
  };

  const isModified = useCallback((key: keyof SimulationParams) => savedParams ? params[key] !== savedParams[key] : false, [params, savedParams]);

  const hasDynamicModel = data && params.chamber_volume_ml > 0;

  const gapVsYData = useMemo(() => data?.Y_positions.map((y, i) => ({ y, gap: data.min_gaps[i] })) || [], [data]);
  const gapVsTimeData = useMemo(() => data?.time_axis_ms.map((t, i) => ({ time: t, gap: data.min_gaps[i], flow: data.flow_l_min[i] })) || [], [data]);

  const pneumaticData = useMemo(() => {
    if (!data) return [];
    let t0 = 0;
    const yArr = data.Y_positions;
    const tArr = data.time_axis_ms;
    for (let i = 0; i < yArr.length - 1; i++) {
      if ((yArr[i] <= 0 && yArr[i + 1] >= 0) || (yArr[i] >= 0 && yArr[i + 1] <= 0)) {
        const ratio = (0 - yArr[i]) / (yArr[i + 1] - yArr[i]);
        t0 = tArr[i] + ratio * (tArr[i + 1] - tArr[i]);
        break;
      }
    }
    return data.Y_positions.map((y, i) => ({
      y,
      flow: data.flow_l_min[i],
      dynamicFlow: hasDynamicModel ? data.dynamic_flow_l_min[i] : undefined,
      gap: data.min_gaps[i],
      time: data.time_axis_ms[i] - t0,
    }));
  }, [data, hasDynamicModel]);

  const stats = useMemo(() => {
    if (!data) return null;
    let t0 = 0;
    const yArr = data.Y_positions;
    const tArr = data.time_axis_ms;
    for (let i = 0; i < yArr.length; i++) { if (yArr[i] >= 0) { t0 = tArr[i]; break; } }
    let tOpen = 0;
    const fArr = data.flow_l_min;
    for (let i = 0; i < fArr.length; i++) { if (fArr[i] > 0.1) { tOpen = tArr[i]; break; } }
    const openTime = Math.max(0, tOpen - t0);
    const staticFlowAtHalfMm = interpolateAlongY(0.5, data.Y_positions, data.flow_l_min);
    return {
      gapAtY0: data.gap_at_Y0,
      staticFlowAtHalfMm,
      openTime,
      maxFlow: Math.max(...data.flow_l_min),
      maxDynamicFlow: hasDynamicModel ? Math.max(...data.dynamic_flow_l_min) : undefined,
      equalizationTime: data.equalization_time_ms,
      totalVolume: data.total_volume_ml,
      // Largest sampled gap with no flow: the FEM tube's closed gap, read off the result.
      zeroFlowGap: data.min_gaps.reduce((m, g, i) => (data.flow_area[i] <= 0 ? Math.max(m, g) : m), 0),
    };
  }, [data, hasDynamicModel]);

  // Same frame as the linkage charts, so a 210 px row holds the card.
  const chartMargin = { top: 6, right: 16, bottom: 18, left: 16 };
  const chartMinHeight = (maximized: boolean) => (maximized ? 320 : 158);
  const legend = <Legend verticalAlign="top" align="right" height={20} iconSize={10} wrapperStyle={{ fontSize: 11 }} />;
  const carriageLine = <ReferenceLine x={travel.y} stroke="#22d3ee" strokeDasharray="5 5" strokeWidth={2} />;
  const carriageTimeMs = data && data.linear_speed_mm_s > 0 ? interpAt(travel.y, data.Y_positions, data.time_axis_ms) : null;

  const renderGapY = ({ maximized, settings: s }: ChartCardView) => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={chartMinHeight(maximized)}>
      <LineChart data={gapVsYData} margin={chartMargin}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="y" type="number" domain={chartDomain(s, 'x', ['dataMin', 'dataMax'])} allowDataOverflow={true} stroke="#888" label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Gap (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={chartDomain(s, 'y', ['dataMin', 'dataMax'])} tickFormatter={(val) => val.toFixed(3)} />
        <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }} formatter={(value: any) => `${Number(value).toFixed(3)} mm`} labelFormatter={(label: any) => `Y: ${Number(label).toFixed(3)} mm`} />
        {data && (
          <>
            <ReferenceLine y={data.gap_at_Y0} stroke="#d946ef" strokeDasharray="3 3">
              {maximized && <Label value={`Gap at center: ${data.gap_at_Y0.toFixed(3)} mm`} position="insideLeft" fill="#d946ef" fontSize={11} fontWeight="bold" />}
            </ReferenceLine>
            <ReferenceLine y={data.default_distance} stroke="#f59e0b" strokeDasharray="3 3">
              {maximized && <Label value={`Rest gap: ${data.default_distance.toFixed(3)} mm`} position="insideBottomLeft" fill="#f59e0b" fontSize={11} fontWeight="bold" />}
            </ReferenceLine>
          </>
        )}
        <Line type="monotone" dataKey="gap" name="Gap" stroke="#3b82f6" strokeWidth={3} dot={false} isAnimationActive={false} />
        <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
          {maximized && <Label value="Bushing center (0 mm)" position="insideTopLeft" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
        </ReferenceLine>
        {carriageLine}
      </LineChart>
    </ResponsiveContainer>
  );

  const renderGapTime = ({ maximized, settings: s }: ChartCardView) => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={chartMinHeight(maximized)}>
      <LineChart data={gapVsTimeData} margin={chartMargin}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="time" type="number" domain={chartDomain(s, 'x', ['dataMin', 'dataMax'])} stroke="#888" label={{ value: 'Time (ms)', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Gap (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={chartDomain(s, 'y', ['dataMin', 'dataMax'])} tickFormatter={(val) => val.toFixed(3)} />
        <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }} formatter={(value: any) => `${Number(value).toFixed(3)} mm`} labelFormatter={(label: any) => `Time: ${Number(label).toFixed(3)} ms`} />
        {data && (
          <>
            <ReferenceLine y={data.gap_at_Y0} stroke="#d946ef" strokeDasharray="3 3">
              {maximized && <Label value={`Gap at center: ${data.gap_at_Y0.toFixed(2)} mm`} position="insideTopLeft" fill="#d946ef" fontSize={11} />}
            </ReferenceLine>
            <ReferenceLine y={data.default_distance} stroke="#f59e0b" strokeDasharray="3 3">
              {maximized && <Label value={`Rest gap: ${data.default_distance.toFixed(2)} mm`} position="insideBottomLeft" fill="#f59e0b" fontSize={11} />}
            </ReferenceLine>
          </>
        )}
        <Line type="monotone" dataKey="gap" name="Gap" stroke="#ef4444" strokeWidth={3} dot={false} isAnimationActive={false} />
        {data && (
          <ReferenceLine x={(-data.Y_positions[0] / (params.motor_speed * params.lead_screw_pitch / 60)) * 1000} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
            {maximized && <Label value="Bushing time" position="insideTopRight" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
          </ReferenceLine>
        )}
        {carriageTimeMs != null && <ReferenceLine x={carriageTimeMs} stroke="#22d3ee" strokeDasharray="5 5" strokeWidth={2} />}
      </LineChart>
    </ResponsiveContainer>
  );

  const renderPneumatic = ({ maximized, settings: s }: ChartCardView) => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={chartMinHeight(maximized)}>
      <LineChart data={pneumaticData} margin={chartMargin}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="y" type="number" domain={chartDomain(s, 'x', ['dataMin', 'dataMax'])} allowDataOverflow={true} stroke="#888" label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888', offset: 0 }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={chartDomain(s, 'y', ['dataMin', 'dataMax'])} tickFormatter={(val) => val.toFixed(3)} />
        <Tooltip
          contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '12px', padding: '12px 16px' }}
          separator=""
          formatter={(value: any, name?: any, props?: any) => {
            if (name === 'Static Flow') {
              const payload = props?.payload;
              return [
                <div key="flow-tip" className="flex flex-col gap-1.5">
                  <div className="flex justify-between gap-6">
                    <span className="text-amber-500 font-black text-2xl tracking-tight">{Number(value).toFixed(3)} L/min</span>
                  </div>
                  {payload && (
                    <div className="text-base text-neutral-400 flex flex-col mt-2 border-t border-neutral-700/50 pt-2 space-y-1">
                      {payload.dynamicFlow !== undefined && (
                        <div className="flex justify-between gap-8">
                          <span className="text-[10px] items-center flex">Dynamic</span>
                          <span className="text-emerald-500 font-mono font-bold">{payload.dynamicFlow.toFixed(3)} L/min</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-8">
                        <span className="text-[10px] items-center flex">Gap</span>
                        <span className="text-blue-500 font-mono font-bold">{payload.gap.toFixed(3)} mm</span>
                      </div>
                      <div className="flex justify-between gap-8">
                        <span className="text-[10px] items-center flex">Time (rel @Y0)</span>
                        <span className="text-red-500 font-mono font-bold">{payload.time.toFixed(2)} ms</span>
                      </div>
                    </div>
                  )}
                </div>,
                null,
              ];
            }
            if (name === 'gap' || name === 'Dynamic Flow') return [null, null];
            return [value, ''];
          }}
          labelFormatter={(label: any) => `Y: ${Number(label).toFixed(3)} mm`}
        />
        {hasDynamicModel && legend}
        <Line type="monotone" dataKey="flow" name="Static Flow" stroke="#f59e0b" strokeWidth={hasDynamicModel ? 2 : 3} strokeDasharray={hasDynamicModel ? '4 2' : undefined} dot={false} isAnimationActive={false} />
        {hasDynamicModel && (
          <Line type="monotone" dataKey="dynamicFlow" name="Dynamic Flow" stroke="#10b981" strokeWidth={3} dot={false} isAnimationActive={false} />
        )}
        <Line type="monotone" dataKey="gap" name="gap" stroke="#3b82f6" strokeWidth={0} strokeOpacity={0} dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
        <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
          {maximized && <Label value="Bushing center (0 mm)" position="insideTopLeft" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
        </ReferenceLine>
        {carriageLine}
      </LineChart>
    </ResponsiveContainer>
  );

  const explorerCard = (key: ExplorerChartKey) => ({
    settings: getExplorerChartSettings(key),
    onSettingsChange: (next: ChartDomainSettings) => setExplorerChartSettings(key, next),
    modified: isExplorerChartSettingsModified(key),
    settingsTitle: `${key} domain settings`,
  });

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: 0.25, ease: 'easeOut' }}>
    <TooltipHintsProvider enabled={guidanceMode}>
    <div data-mobile-pane={mobilePane} className="bui-workspace-shell cam-workspace w-full text-neutral-100 px-2.5 sm:px-4 pb-0 lg:pb-4 overflow-hidden flex flex-col gap-2.5 lg:gap-4">

      <BlueprintBackground />
      {/* Shared chrome; simulation controls stay in the tool. */}
      <Header variant="full-width" blur={false} className="cam-kit-header">
        <div className="flex w-full sm:w-auto flex-1 min-w-0 items-center gap-2 lg:gap-4">
          <div className="hidden lg:block shrink-0">
            <h1 className="text-2xl font-bold text-neutral-100 leading-tight">
              Cam Profile Simulator
            </h1>
            <p className="text-xs text-neutral-400 mt-0.5">Pneumatic valve opening simulation</p>
          </div>

          {/* Tab Bar */}
          <div className="cam-tab-row flex w-full sm:w-auto min-w-0 max-w-full flex-wrap items-center gap-1.5 sm:gap-2">
            {/* Row 1 on phones: horizontally scrollable tabs + compact Tools drawer trigger. */}
            <div className="flex w-full sm:w-auto min-w-0 items-center gap-1.5">
              {/* Plain buttons with the kit's tab classes, as in SubTabs: a kit ghost Button paints over the selected state. */}
              <div className="bui-tablist cam-tab-strip flex flex-1 sm:flex-initial min-w-0 max-w-full flex-wrap items-center">
                {([
                  ['cam', 'Cam', Disc3],
                  ['linkage', 'Bar Linkage', Waypoints],
                  ['lever', 'Lever Linkage', Spline],
                  ['pendulum', 'Pendulum Linkage', Anchor],
                  ['compliant', 'Compliant Bars', PenLine],
                ] as const).map(([tab, label, Icon]) => (
                  <button key={tab} type="button" onClick={(e) => {
                    setActiveTab(tab);
                    e.currentTarget.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                  }} aria-pressed={activeTab === tab}
                    className={`bui-tab flex shrink-0 items-center gap-1.5 sm:gap-2 whitespace-nowrap px-2.5 py-1 text-xs${activeTab === tab ? ' bui-tab--active' : ''}`}>
                    <Icon className="w-3.5 h-3.5 shrink-0" /> {label}
                  </button>
                ))}
              </div>
              <div className="flex sm:hidden shrink-0 items-center gap-1.5">
                <span className={`flex h-2.5 w-2.5 rounded-full ${data ? 'bg-emerald-500' : 'bg-red-500'} ${loading ? 'animate-pulse' : ''}`} title={data ? 'Connected' : 'Disconnected'} />
                <Button variant="ghost" type="button" onClick={() => setMobileToolsOpen(true)}
                  className="flex items-center justify-center rounded-lg border border-neutral-700 px-2.5 py-1.5 text-neutral-200"
                  aria-label="Tools and settings" aria-haspopup="dialog" aria-expanded={mobileToolsOpen}>
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {/* Row 2 on phones: Mode switcher + Profile pill cleanly side-by-side (wraps on very narrow screens when dirty). */}
            <div className="flex w-full sm:w-auto min-w-0 flex-wrap sm:flex-nowrap items-center justify-between sm:justify-start gap-x-2 gap-y-1.5">
              <SubTabs label="Mode" value={subTab} options={activeTab === 'compliant' ? SOLVER_SUB_TABS : SUB_TABS} onChange={(v) => setSubTab(activeTab, v)} />
              <div className="ml-auto sm:ml-0 max-w-full flex justify-end sm:justify-start">
                <ProfilePill state={profileState} onImport={() => setImportType(profileType)}
                  onSaveAsNew={() => { void openSaveDialog(); }} onUpdate={() => { void updateProfile(); }}
                  onRevert={() => { void revertProfile(); }} />
              </div>
            </div>
          </div>
        </div>
        <div className="hidden sm:flex shrink-0 items-center gap-2">
          <Button variant="ghost"
            type="button"
            onClick={() => setShowStlExport(true)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-emerald-600/50 bg-emerald-600/20 text-emerald-300 hover:bg-emerald-600/30 hover:text-emerald-100 text-[11px] font-semibold transition-colors shadow-sm"
            title="Export the current cam configuration as an STL via Onshape"
            aria-label="Export STL via Onshape"
          >
            <Box className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Export STL</span>
          </Button>
          <Button variant="ghost"
            type="button"
            onClick={() => setGuidanceMode((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors ${
 guidanceMode
 ? 'border-blue-500/50 bg-blue-600/20 text-blue-300 hover:bg-blue-600/30'
 : 'border-neutral-700 bg-neutral-800/50 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/60'
 }`}
            title={guidanceMode ? 'Guidance mode on: tooltips enabled' : 'Guidance mode off: tooltips disabled'}
            aria-label="Guidance tooltips"
            aria-pressed={guidanceMode}
          >
            <CircleHelp className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Guidance</span>
          </Button>
          <span className={`flex h-3 w-3 rounded-full ${data ? 'bg-emerald-500' : 'bg-red-500'} ${loading ? 'animate-pulse' : ''}`} title={data ? 'Connected' : 'Disconnected'} />
          {/* Spelled out on very wide screens only, so the header keeps one row; the dot carries it otherwise. */}
          <span className="sr-only min-[1700px]:not-sr-only text-sm text-neutral-400">{data ? 'Connected' : 'Disconnected'}</span>
          <ThemeToggle theme={theme} onThemeChange={setTheme} />
        </div>
      </Header>

      {error && (
        <div className="shrink-0 bg-red-900/50 border border-red-500 text-red-200 p-3 rounded-lg text-sm">{error}</div>
      )}

      {/* ─── TAB CONTENT ─── */}
      {camExplorer ? (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">

          {/* Panel 1: Parameters */}
          <div data-pane="controls" className="lg:col-span-3 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 flex flex-col min-h-0">
            <div className="flex items-center gap-3 mb-6 min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Settings className="w-5 h-5 text-blue-500 shrink-0" />
                <h2 className="text-lg font-bold text-white tracking-tight truncate">Configuration</h2>
              </div>
              <div className="flex gap-2 shrink-0">
                <Input type="file" ref={fileInputRef} onChange={handleLoadConfig} accept=".json" className="hidden" />
                <Button variant="ghost" onClick={() => {
                  saveAsNew('cam', camHandle, '', params.note)
                    .catch((err) => showToast(`Not saved: ${err instanceof Error ? err.message : err}`));
                }}
                  className="p-2 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 transition-all border border-blue-600/50 flex items-center justify-center shadow-sm"
                  title="Save Configuration as New File">
                  <Download className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 space-y-4 scrollbar-thin scrollbar-thumb-neutral-600 scrollbar-track-transparent">
            <AccordionScope id="cam:explorer">
              <div className="space-y-2 pb-2 border-b border-neutral-700/50">
                <label className={`text-sm font-medium tracking-tight flex items-center gap-2 ${isModified('note') ? 'text-amber-400' : 'text-neutral-300'}`}>
                  Note
                  {isModified('note') && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 hidden xl:block" />}
                </label>
                <Textarea value={params.note} onChange={(e) => handleNoteChange(e.target.value)}
                  placeholder="Describe this profile..."
                  rows={3}
                  className={`w-full resize-y min-h-[4.5rem] rounded-lg border bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 ${isModified('note') ? 'border-amber-500/50' : 'border-neutral-700'}`} />
              </div>

              <Accordion title="Geometry">
                <div className="space-y-5 pt-2">
                  <ParameterSlider label="Height (mm)" value={params.height} min={0.01} max={8.0} step={0.01} onChange={(val) => handleParamChange('height', val)} isModified={isModified('height')} description={explorerHeight} />
                  <ParameterSlider label="Curve Gain (K)" value={params.K} min={0.1} max={10.0} step={0.1} onChange={(val) => handleParamChange('K', val)} isModified={isModified('K')} description={explorerK} />
                  <ParameterSlider label="Deadband (mm)" value={params.deadband} min={0.05} max={8.0} step={0.05} onChange={(val) => handleParamChange('deadband', val)} isModified={isModified('deadband')} description={explorerDeadband} />
                  <ParameterSlider label="Default Dist (mm)" value={params.default_distance} min={0.01} max={2.0} step={0.01} onChange={(val) => handleParamChange('default_distance', val)} isModified={isModified('default_distance')} description={explorerDefaultDist} />
                  <ClosureRampToggle value={params.ramp_enabled} onChange={(val) => handleParamChange('ramp_enabled', val)} isModified={isModified('ramp_enabled')} />
                  <ParameterSlider label="Thickness (mm)" value={params.thickness} min={0.1} max={5.0} step={0.1} onChange={(val) => handleParamChange('thickness', val)} isModified={isModified('thickness')} description={explorerThickness} />
                </div>
              </Accordion>

              <Accordion title="Pneumatic system">
                <div className="space-y-5 pt-2">
                  <ParameterSlider label="Pressure (kPa)" value={params.input_pressure_kpa} min={0} max={1050} step={1} inputDecimals={1}
                    onChange={(val) => handleParamChange('input_pressure_kpa', val)}
                    isModified={isModified('input_pressure_kpa')}
                    description={explorerPressure}
                  />
                  <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1.0} max={12.0} step={0.1} onChange={(val) => handleParamChange('tube_id', val)} isModified={isModified('tube_id')} description={explorerTubeId} />
                  <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1.0} max={16.0} step={0.1} onChange={(val) => handleParamChange('tube_od', val)} isModified={isModified('tube_od')} description={explorerTubeOd} />
                  <TubeModelControls model={params.tube_model} shore={params.tube_shore_a}
                    onModel={(m) => setParams((prev) => ({ ...prev, tube_model: m }))}
                    onShore={(val) => handleParamChange('tube_shore_a', val)}
                    modelModified={isModified('tube_model')} shoreModified={isModified('tube_shore_a')} />
                  <ParameterSlider label="Compliance" value={params.compliance} min={0.0} max={5.0} step={0.01}
                    onChange={(val) => handleParamChange('compliance', val)}
                    secondaryValue={params.tube_model === 'simple' ? `Opening: ${(params.compliance * params.input_pressure_kpa * 1e-3).toFixed(3)} mm` : 'Simple model only'}
                    disabled={params.tube_model !== 'simple'}
                    isModified={isModified('compliance')}
                    description={explorerCompliance}
                  />
                  <ParameterSlider label="Chamber Vol (mL)" value={params.chamber_volume_ml} min={0} max={100} step={0.5}
                    onChange={(val) => handleParamChange('chamber_volume_ml', val)}
                    secondaryValue={params.chamber_volume_ml === 0 ? 'Static model' : 'Dynamic'}
                    isModified={isModified('chamber_volume_ml')}
                    description={explorerChamberVol}
                  />
                </div>
              </Accordion>

              <Accordion title="Motor and screw">
                <div className="space-y-5 pt-2">
                  <ParameterSlider label="Motor Speed" value={params.motor_speed} min={10} max={1000} step={10} onChange={(val) => handleParamChange('motor_speed', val)} isModified={isModified('motor_speed')} description={explorerMotorSpeed} />
                </div>
              </Accordion>

              {stats && (
                <Accordion title="Results" showBottomBorder={false}>
                  <div className="space-y-2 pt-2">
                    <StatRow label="Open Latency"
                      value={
                        <div className="flex items-center gap-1.5">
                          <span>{stats.openTime.toFixed(3)} ms</span>
                          <span className="text-[10px] text-neutral-500 font-normal">
                            ({((params.motor_speed * params.lead_screw_pitch / 60) * (stats.openTime / 1000)).toFixed(3)} mm)
                          </span>
                        </div>
                      }
                      highlight={true} />
                    <StatRow label="Gap at Y=0" value={`${stats.gapAtY0.toFixed(3)} mm`} />
                    {params.ramp_enabled && <StatRow label="Zero-flow gap ≤" value={`${(params.tube_model === 'simple' ? params.tube_od - params.tube_id - params.compliance * params.input_pressure_kpa * 1e-3 : stats.zeroFlowGap).toFixed(3)} mm`} />}
                    <StatRow label="Max Flow (static)" value={`${stats.maxFlow.toFixed(3)} L/min`} />
                    {stats.maxDynamicFlow !== undefined && (
                      <StatRow label="Max Flow (dynamic)" value={`${stats.maxDynamicFlow.toFixed(3)} L/min`} />
                    )}
                    <StatRow
                      label="Static flow @ Y=0.5 mm"
                      value={
                        stats.staticFlowAtHalfMm !== null
                          ? `${stats.staticFlowAtHalfMm.toFixed(3)} L/min`
                          : 'N/A'
                      }
                    />
                    {hasDynamicModel && (
                      <>
                        <StatRow label="Total Volume" value={`${stats.totalVolume.toFixed(2)} mL`} />
                        <StatRow label="Equalization" value={stats.equalizationTime >= 0 ? `${stats.equalizationTime.toFixed(1)} ms` : 'N/A'} />
                      </>
                    )}
                  </div>
                </Accordion>
              )}
            </AccordionScope>
            </div>
          </div>

          {/* Panel 2: schematic */}
          <CamSchematicCard id="explorer" data={data} params={params} travel={travel} details={detailsView} setDetails={setDetailsView}
            speedNote={`${params.motor_speed} RPM × ${params.lead_screw_pitch} mm pitch`} />

          {/* Panel 3: charts */}
          <div data-pane="charts" className="lg:col-span-5 min-w-0 grid auto-rows-[minmax(210px,1fr)] gap-4 min-h-0 overflow-y-auto pr-1">
            <ChartCard title="Pneumatic Flow vs Y" {...explorerCard('pneumatic')}>
              {renderPneumatic}
            </ChartCard>
            <ChartCard title="Gap vs Y" maximizedTitle="Gap vs Y Position" {...explorerCard('gapY')}>
              {renderGapY}
            </ChartCard>
            <ChartCard title="Gap vs Time" {...explorerCard('gapTime')}>
              {renderGapTime}
            </ChartCard>
            <TubeSectionCard tube={params} h={data && data.Y_positions.length > 0 ? interpAt(travel.y, data.Y_positions, data.min_gaps) : null}
              where={`cam gap at Y = ${travel.y.toFixed(2)} mm`} {...explorerCard('section')} />
          </div>
        </div>
      ) : activeTab === 'compliant' ? (
        <CompliantBars
          mode={subTab}
          onOpenExplorer={() => { setSubTab('compliant', 'explorer'); setMobilePane('schematic'); }}
          onProfileStateChange={setCompliantProfile}
          profileRef={compliantRef}
        />
      ) : activeTab !== 'cam' ? (
        <LinkageExplorer
          key={activeTab}
          kind={activeTab === 'linkage' ? 'elbow' : activeTab}
          mode={subTab}
          onOpenExplorer={() => { setSubTab(activeTab, 'explorer'); setMobilePane('schematic'); }}
          onProfileStateChange={(state) => setLinkageProfile({ type: activeTab === 'linkage' ? 'elbow' : activeTab, state })}
          profileRef={linkageRef}
          shared={{
            tube_id: params.tube_id,
            tube_od: params.tube_od,
            input_pressure_kpa: params.input_pressure_kpa,
            compliance: params.compliance,
            tube_model: params.tube_model,
            tube_shore_a: params.tube_shore_a,
            motor_speed: params.motor_speed,
            lead_screw_pitch: params.lead_screw_pitch,
          }}
        />
      ) : null}
      {(builderMounted || camFinder) && (
        <div className={camFinder ? 'cam-keepalive contents' : 'hidden'}>
          <KeptProfileBuilder
            onApplyToExplorer={handleApplyFromBuilder}
            onSolveStart={handleShowMobileResults}
            explorerCompliance={params.compliance}
            explorerTubeModel={params.tube_model}
            explorerShoreA={params.tube_shore_a}
            guidanceEnabled={guidanceMode}
            onProfileStateChange={setFinderProfile}
            profileRef={finderRef}
          />
        </div>
      )}

      {/* Mobile & tablet bottom pane switcher (below lg) */}
      <nav aria-label="Workspace view" className="cam-mobile-nav -mx-2.5 sm:-mx-4 shrink-0 px-2 pt-1.5 lg:hidden">
        <div role="tablist" aria-label="Workspace panels" className="grid grid-cols-3 gap-1">
          {MOBILE_PANES.map(({ id, label, Icon }) => {
            const selected = mobilePane === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setMobilePane(id)}
                className="cam-mobile-nav__btn flex min-h-[44px] flex-col items-center justify-center gap-0.5 px-2 py-1 text-xs font-medium"
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Mobile Tools bottom drawer */}
      <Drawer open={mobileToolsOpen} onClose={() => setMobileToolsOpen(false)} side="bottom" label="Tools">
        {mobileToolsOpen && (
          <div className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-700/70 bg-neutral-900/40 px-3 py-2.5 text-sm">
              <span className="text-neutral-300">Simulation server</span>
              <span className="inline-flex items-center gap-2 text-xs font-medium text-neutral-200">
                <span className={`h-2.5 w-2.5 rounded-full ${data ? 'bg-emerald-500' : 'bg-red-500'} ${loading ? 'animate-pulse' : ''}`} />
                {data ? 'Connected' : 'Disconnected'}
              </span>
            </div>
            <Button variant="ghost" type="button"
              onClick={() => { setMobileToolsOpen(false); setShowStlExport(true); }}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-600/50 bg-emerald-600/20 px-3 py-2.5 text-sm font-semibold text-emerald-300">
              <Box className="w-4 h-4" />
              Export STL via Onshape
            </Button>
            <Button variant="ghost" type="button"
              onClick={() => setGuidanceMode((v) => !v)}
              aria-pressed={guidanceMode}
              className="flex w-full items-center justify-between gap-3 rounded-lg border border-neutral-700 px-3 py-2.5 text-sm text-neutral-200">
              <span className="inline-flex items-center gap-2">
                <CircleHelp className="w-4 h-4" />
                Guidance hints
              </span>
              <span className="text-xs font-mono text-neutral-400">{guidanceMode ? 'On' : 'Off'}</span>
            </Button>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200">
              <span>Appearance</span>
              <ThemeToggle theme={theme} onThemeChange={setTheme} />
            </div>
          </div>
        )}
      </Drawer>

      {/* Modals & Overlays */}
      <StlExportModal
        isOpen={showStlExport}
        onClose={() => setShowStlExport(false)}
        params={params}
        configName={activeConfigName ?? 'Default'}
      />

      <ProfileImportModal
        open={importType !== null} onClose={() => setImportType(null)} type={importType ?? profileType}
        renderPreview={renderProfilePreview(importType ?? profileType)}
        onOpen={(p) => {
          const handle = profileHandle();
          if (!handle || handle.type !== p.type) throw new Error('the open tab changed');
          handle.apply(p);
        }}
        onDeleted={(name) => {
          const handle = profileHandle();
          if (handle && handle.type === importType && name === profileState.name) handle.detach();
        }}
      />
      <ProfileSaveDialog
        open={saveTarget !== null}
        onClose={() => setSaveTarget(null)}
        type={saveTarget?.type ?? profileType}
        initialName={suggestNextProfileName(saveTarget?.loaded ?? null)}
        initialNote={saveTarget?.note ?? ''}
        onSave={(name, note) => (saveTarget ? saveAsNew(saveTarget.type, saveTarget.handle, name, note) : Promise.resolve(false))}
      />

      <AnimatePresence>
        {toast.visible && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }}
            className="fixed bottom-20 lg:bottom-8 left-1/2 -translate-x-1/2 z-[200] max-w-[calc(100vw-2rem)] bg-neutral-800 border-2 border-blue-500/50 text-white px-4 sm:px-6 py-2.5 sm:py-3 rounded-2xl flex items-center gap-3">
            <div className="w-2 h-2 shrink-0 rounded-full bg-blue-500" />
            <span className="text-sm font-bold tracking-tight truncate">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </TooltipHintsProvider>
    </MotionConfig>
  );
}
