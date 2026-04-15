import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Label
} from 'recharts';
import {
  Settings, Maximize2, Minimize2, Import, Download, RefreshCw, FlaskConical, Search, CircleHelp, Cog
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { SimulationParams, SimulationResult, SavedConfigEntry } from './components';
import {
  ParameterSlider, StatRow, Accordion, VerticalSystemView, ConfigModal, TooltipHintsProvider, ChartDomainSettingsModal,
  apiUrl, defaultParams, mergeConfigParams,
} from './components';
import type { ChartDomainSettings } from './components';
import ProfileBuilder from './ProfileBuilder';
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

type ExplorerChartKey = 'pneumatic' | 'gapY' | 'gapTime';

const DEFAULT_DOMAIN: ChartDomainSettings = { autoX: true, autoY: true, xMin: -1, xMax: 1, yMin: -1, yMax: 1 };

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
  const [activeTab, setActiveTab] = useState<'explorer' | 'builder'>('explorer');
  const [params, setParams] = useState<SimulationParams>(defaultParams);
  const [savedParams, setSavedParams] = useState<SimulationParams | null>(null);
  const [data, setData] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maximizedChart, setMaximizedChart] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [configs, setConfigs] = useState<SavedConfigEntry[]>([]);
  const [defaultConfig, setDefaultConfig] = useState<string | null>(null);
  const [activeConfigName, setActiveConfigName] = useState<string>('Default');
  const [previewParams, setPreviewParams] = useState<SimulationParams | null>(null);
  const [previewData, setPreviewData] = useState<SimulationResult | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [activeBuilderExperienceName, setActiveBuilderExperienceName] = useState('Unsaved');
  const [openBuilderExperienceSignal, setOpenBuilderExperienceSignal] = useState(0);
  const [saveBuilderExperienceSignal, setSaveBuilderExperienceSignal] = useState(0);
  /** Profile Builder: show SAVE/UPDATE in header when a solve can be persisted and is not yet saved. */
  const [builderSaveExperienceVisible, setBuilderSaveExperienceVisible] = useState(false);
  const [guidanceMode, setGuidanceMode] = useState(true);
  const [chartSettingsTarget, setChartSettingsTarget] = useState<ExplorerChartKey | null>(null);
  const [toast, setToast] = useState<{ message: string; visible: boolean }>({ message: '', visible: false });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const simulateAbortRef = useRef<AbortController | null>(null);
  const [detailsView, setDetailsView] = useState(false);

  const getExplorerChartSettings = useCallback((key: ExplorerChartKey): ChartDomainSettings => {
    const root = (params.chart_settings ?? {}) as Record<string, unknown>;
    const explorer = (root.explorer ?? {}) as Record<string, unknown>;
    const raw = explorer[key] as Partial<ChartDomainSettings> | undefined;
    const fallback: Record<ExplorerChartKey, ChartDomainSettings> = {
      pneumatic: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 25 },
      gapY: { autoX: true, autoY: true, xMin: -1.5, xMax: 4, yMin: 0, yMax: 2 },
      gapTime: { autoX: true, autoY: true, xMin: 0, xMax: 100, yMin: 0, yMax: 2 },
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
    };
    const saved = { ...fallback[key], ...((savedExplorer[key] as Partial<ChartDomainSettings> | undefined) ?? {}) };
    return JSON.stringify(cur) !== JSON.stringify(saved);
  }, [savedParams, getExplorerChartSettings]);

  const showToast = (message: string) => {
    setToast({ message, visible: true });
    setTimeout(() => setToast({ message: '', visible: false }), 3000);
  };

  // Cross-tab: apply params from Profile Builder
  const handleApplyFromBuilder = (builderParams: SimulationParams) => {
    setParams(builderParams);
    setSavedParams(null);
    setActiveConfigName('Builder');
    setActiveTab('explorer');
    showToast('Profile applied from Builder');
  };

  const fetchConfigs = async () => {
    try {
      const res = await fetch(apiUrl('/api/configs'));
      const listData = await res.json();
      const raw = listData.configs as unknown;
      const normalized: SavedConfigEntry[] = Array.isArray(raw)
        ? raw.map((c: unknown) =>
          typeof c === 'string'
            ? { filename: c, note: '' }
            : { filename: (c as SavedConfigEntry).filename, note: typeof (c as SavedConfigEntry).note === 'string' ? (c as SavedConfigEntry).note : '' }
        )
        : [];
      setConfigs(normalized);
      const defRes = await fetch(apiUrl('/api/configs/default'));
      const defData = await defRes.json();
      setDefaultConfig(defData.default);
    } catch (err) {
      console.error('Error fetching configs:', err);
    }
  };

  useEffect(() => {
    fetchConfigs();
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/configs/default'));
        const data = await res.json();
        if (data.default && data.default !== 'none') {
          const configRes = await fetch(apiUrl(`/api/configs/${data.default}`));
          if (configRes.ok) {
            const configParams = await configRes.json();
            const merged = mergeConfigParams(configParams);
            setParams(merged);
            setSavedParams(merged);
            setDefaultConfig(data.default);
            setActiveConfigName(data.default);
            showToast(`Startup profile loaded: ${data.default}`);
          }
        }
      } catch (err) {
        console.error('Error loading default config:', err);
      }
    })();
  }, []);

  const handleApplyConfig = () => {
    if (previewParams) {
      setParams(previewParams);
      setSavedParams(previewParams);
      setShowImportModal(false);
      if (selectedConfig) setActiveConfigName(selectedConfig);
    }
  };

  const handleOpenConfigByName = async (name: string) => {
    try {
      const res = await fetch(apiUrl(`/api/configs/${name}`));
      if (!res.ok) throw new Error(`Failed to load ${name}`);
      const configParams = await res.json();
      const merged = mergeConfigParams(configParams);
      setParams(merged);
      setSavedParams(merged);
      setActiveConfigName(name);
      setSelectedConfig(name);
      setPreviewParams(merged);
      setShowImportModal(false);
    } catch (err) {
      console.error('Error opening config:', err);
    }
  };

  const loadConfigData = async (name: string) => {
    try {
      const res = await fetch(apiUrl(`/api/configs/${name}`));
      const configParams = await res.json();
      const merged = mergeConfigParams(configParams);
      setPreviewParams(merged);
      const simRes = await fetch(apiUrl('/api/simulate'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(merged),
      });
      const simResult = await simRes.json();
      setPreviewData(simResult);
    } catch (err) {
      console.error('Error loading config:', err);
    }
  };

  const handleSetDefault = async (name: string) => {
    try {
      await fetch(apiUrl(`/api/configs/default/${name}`), { method: 'POST' });
      setDefaultConfig(name);
    } catch (err) {
      console.error('Error setting default config:', err);
    }
  };

  const handleDeleteConfig = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to delete ${name}?`)) return;
    try {
      if (defaultConfig === name) {
        await fetch(apiUrl('/api/configs/default/none'), { method: 'POST' });
        setDefaultConfig(null);
      }
      await fetch(apiUrl(`/api/configs/${name}`), { method: 'DELETE' });
      if (selectedConfig === name) { setSelectedConfig(null); setPreviewParams(null); setPreviewData(null); }
      fetchConfigs();
    } catch (err) {
      console.error('Error deleting config:', err);
    }
  };

  const handleSaveConfig = async () => {
    try {
      const res = await fetch(apiUrl('/api/save-config'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
      const data = await res.json();
      setActiveConfigName(data.filename);
      setSavedParams(params);
      showToast('Simulation Config Saved to Repo');
      fetchConfigs();
    } catch (err) {
      console.error('Error saving config:', err);
      showToast('Error saving config');
    }
  };

  const handleUpdateConfig = async () => {
    try {
      if (activeConfigName === 'Default' || !activeConfigName.endsWith('.json')) return handleSaveConfig();
      await fetch(apiUrl(`/api/configs/${activeConfigName}`), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      });
      setSavedParams(params);
      showToast(`Profile ${activeConfigName} updated`);
      fetchConfigs();
    } catch (err) {
      console.error('Error updating config:', err);
      showToast('Error updating config');
    }
  };

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
      const response = await fetch(apiUrl('/api/simulate'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentParams),
        signal: ac.signal,
      });
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

  const handleParamChange = (key: Exclude<keyof SimulationParams, 'note'>, value: number) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const handleNoteChange = (value: string) => {
    setParams(prev => ({ ...prev, note: value }));
  };

  const hasChanges = useMemo(() => savedParams ? JSON.stringify(params) !== JSON.stringify(savedParams) : false, [params, savedParams]);
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
    };
  }, [data, hasDynamicModel]);

  const renderGapY = () => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
      <LineChart data={gapVsYData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="y" type="number" domain={getExplorerChartSettings('gapY').autoX ? ['dataMin', 'dataMax'] : [getExplorerChartSettings('gapY').xMin, getExplorerChartSettings('gapY').xMax]} allowDataOverflow={true} stroke="#888" label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888' }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Gap (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={getExplorerChartSettings('gapY').autoY ? ['dataMin', 'dataMax'] : [getExplorerChartSettings('gapY').yMin, getExplorerChartSettings('gapY').yMax]} tickFormatter={(val) => val.toFixed(3)} />
        <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }} formatter={(value: any) => `${Number(value).toFixed(3)} mm`} labelFormatter={(label: any) => `Y: ${Number(label).toFixed(3)} mm`} />
        {data && (
          <>
            <ReferenceLine y={data.gap_at_Y0} stroke="#d946ef" strokeDasharray="3 3">
              {maximizedChart === 'gapY' && <Label value={`GAP AT CENTER: ${data.gap_at_Y0.toFixed(3)} mm`} position="insideLeft" fill="#d946ef" fontSize={11} fontWeight="bold" />}
            </ReferenceLine>
            <ReferenceLine y={data.default_distance} stroke="#f59e0b" strokeDasharray="3 3">
              {maximizedChart === 'gapY' && <Label value={`REST GAP: ${data.default_distance.toFixed(3)} mm`} position="insideBottomLeft" fill="#f59e0b" fontSize={11} fontWeight="bold" />}
            </ReferenceLine>
          </>
        )}
        <Line type="monotone" dataKey="gap" name="Gap" stroke="#3b82f6" strokeWidth={3} dot={false} isAnimationActive={false} />
        <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
          {maximizedChart === 'gapY' && <Label value="BUSHING CENTER (0mm)" position="insideTopLeft" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
        </ReferenceLine>
      </LineChart>
    </ResponsiveContainer>
  );

  const renderGapTime = () => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
      <LineChart data={gapVsTimeData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="time" type="number" domain={getExplorerChartSettings('gapTime').autoX ? ['dataMin', 'dataMax'] : [getExplorerChartSettings('gapTime').xMin, getExplorerChartSettings('gapTime').xMax]} stroke="#888" label={{ value: 'Time (ms)', position: 'bottom', fill: '#888' }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Gap (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={getExplorerChartSettings('gapTime').autoY ? ['dataMin', 'dataMax'] : [getExplorerChartSettings('gapTime').yMin, getExplorerChartSettings('gapTime').yMax]} tickFormatter={(val) => val.toFixed(3)} />
        <Tooltip contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px' }} formatter={(value: any) => `${Number(value).toFixed(3)} mm`} labelFormatter={(label: any) => `Time: ${Number(label).toFixed(3)} ms`} />
        {data && (
          <>
            <ReferenceLine y={data.gap_at_Y0} stroke="#d946ef" strokeDasharray="3 3">
              {maximizedChart === 'gapTime' && <Label value={`GAP AT CENTER: ${data.gap_at_Y0.toFixed(2)} mm`} position="insideTopLeft" fill="#d946ef" fontSize={11} />}
            </ReferenceLine>
            <ReferenceLine y={data.default_distance} stroke="#f59e0b" strokeDasharray="3 3">
              {maximizedChart === 'gapTime' && <Label value={`REST GAP: ${data.default_distance.toFixed(2)} mm`} position="insideBottomLeft" fill="#f59e0b" fontSize={11} />}
            </ReferenceLine>
          </>
        )}
        <Line type="monotone" dataKey="gap" name="Gap" stroke="#ef4444" strokeWidth={3} dot={false} isAnimationActive={false} />
        {data && (
          <ReferenceLine x={(-data.Y_positions[0] / (params.motor_speed * params.lead_screw_pitch / 60)) * 1000} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
            {maximizedChart === 'gapTime' && <Label value="BUSHING TIME" position="insideTopRight" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
          </ReferenceLine>
        )}
      </LineChart>
    </ResponsiveContainer>
  );

  const renderPneumatic = () => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={260}>
      <LineChart data={pneumaticData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="y" type="number" domain={getExplorerChartSettings('pneumatic').autoX ? ['dataMin', 'dataMax'] : [getExplorerChartSettings('pneumatic').xMin, getExplorerChartSettings('pneumatic').xMax]} allowDataOverflow={true} stroke="#888" label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888' }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={getExplorerChartSettings('pneumatic').autoY ? ['dataMin', 'dataMax'] : [getExplorerChartSettings('pneumatic').yMin, getExplorerChartSettings('pneumatic').yMax]} tickFormatter={(val) => val.toFixed(3)} />
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
                          <span className="uppercase text-[10px] items-center flex">Dynamic</span>
                          <span className="text-emerald-500 font-mono font-bold">{payload.dynamicFlow.toFixed(3)} L/min</span>
                        </div>
                      )}
                      <div className="flex justify-between gap-8">
                        <span className="uppercase text-[10px] items-center flex">Gap</span>
                        <span className="text-blue-500 font-mono font-bold">{payload.gap.toFixed(3)} mm</span>
                      </div>
                      <div className="flex justify-between gap-8">
                        <span className="uppercase text-[10px] items-center flex">Time (rel @Y0)</span>
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
        <Line type="monotone" dataKey="flow" name="Static Flow" stroke="#f59e0b" strokeWidth={hasDynamicModel ? 2 : 3} strokeDasharray={hasDynamicModel ? '4 2' : undefined} dot={false} isAnimationActive={false} />
        {hasDynamicModel && (
          <Line type="monotone" dataKey="dynamicFlow" name="Dynamic Flow" stroke="#10b981" strokeWidth={3} dot={false} isAnimationActive={false} />
        )}
        <Line type="monotone" dataKey="gap" name="gap" stroke="#3b82f6" strokeWidth={0} strokeOpacity={0} dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
        <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
          {maximizedChart === 'pneumatic' && <Label value="BUSHING CENTER (0mm)" position="insideTopLeft" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
        </ReferenceLine>
      </LineChart>
    </ResponsiveContainer>
  );

  const getChartContent = (id: string | null) => {
    switch (id) {
      case 'gapY': return { title: 'Gap vs Y Position', comp: renderGapY() };
      case 'gapTime': return { title: 'Gap vs Time', comp: renderGapTime() };
      case 'pneumatic': return { title: 'Pneumatic Flow vs Y', comp: renderPneumatic() };
      default: return null;
    }
  };
  const maximizedInfo = getChartContent(maximizedChart);

  return (
    <TooltipHintsProvider enabled={guidanceMode}>
    <div className="h-screen w-full bg-neutral-900 text-neutral-100 p-4 font-sans overflow-hidden flex flex-col">

      {/* Header */}
      <header className="shrink-0 flex justify-between items-center pb-3 border-b border-neutral-800">
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent leading-tight hidden lg:block">
              Cam Profile Simulator
            </h1>
            <p className="text-xs text-neutral-400 mt-0.5">Pneumatic valve opening simulation</p>
          </div>

          {/* Tab Bar */}
          <div className="flex items-center bg-neutral-800/60 rounded-xl border border-neutral-700/50 p-1 gap-1">
            <button onClick={() => setActiveTab('explorer')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${activeTab === 'explorer' ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/20' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50'}`}>
              <Search className="w-3.5 h-3.5" /> Explorer
            </button>
            <button onClick={() => setActiveTab('builder')}
              className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${activeTab === 'builder' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/20' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50'}`}>
              <FlaskConical className="w-3.5 h-3.5" /> Profile Builder
            </button>
          </div>

          {/* Context pill (tab-specific) */}
          {activeTab === 'explorer' && (
            <div className="flex items-center gap-2.5 flex-wrap min-w-0">
              <div className={`inline-flex min-w-0 max-w-full items-center gap-0 rounded-xl border p-1 shadow-sm transition-colors ${hasChanges ? 'border-amber-500/35 bg-amber-950/20' : 'border-neutral-700/80 bg-neutral-800/50'}`} title={activeConfigName}>
                <div className={`flex min-w-0 max-w-[min(100vw-8rem,18rem)] sm:max-w-[22rem] items-center gap-2 rounded-lg px-2.5 py-1.5 ${hasChanges ? 'bg-amber-500/5' : 'bg-neutral-900/40'}`}>
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Profile</span>
                  <span className={`min-w-0 truncate font-mono text-xs sm:text-sm font-medium tabular-nums ${hasChanges ? 'text-amber-300' : 'text-emerald-400'}`}>
                    {activeConfigName}{hasChanges ? <span className="text-amber-400">*</span> : null}
                  </span>
                </div>
                <button type="button" onClick={() => { fetchConfigs(); setShowImportModal(true); }}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70"
                  title="Browse and import a JSON config from the repo" aria-label="Import configuration from repository">
                  <Import className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
                  <span className="hidden sm:inline">Import</span>
                </button>
              </div>
              <AnimatePresence>
                {hasChanges && (
                  <motion.button initial={{ opacity: 0, scale: 0.8, x: -10 }} animate={{ opacity: 1, scale: 1, x: 0 }} exit={{ opacity: 0, scale: 0.8, x: -10 }}
                    onClick={handleUpdateConfig}
                    className="relative cursor-pointer px-3 py-1 bg-amber-500 hover:bg-amber-400 text-neutral-900 border border-amber-400 rounded-full shadow-[0_0_15px_rgba(245,158,11,0.5)] flex items-center gap-1.5 transition-all outline-none font-bold text-[10px] uppercase tracking-wider"
                    title="Update currently loaded config">
                    <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-100" />
                    </span>
                    <RefreshCw className="w-3 h-3" /> UPDATE
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          )}
          {activeTab === 'builder' && (
            <div className="flex items-center gap-2.5 flex-wrap min-w-0">
              <div
                className="inline-flex min-w-0 max-w-full items-center gap-0 rounded-xl border border-neutral-700/80 bg-neutral-800/50 p-1 shadow-sm transition-colors"
                title={activeBuilderExperienceName}
              >
                <div className="flex min-w-0 max-w-[min(100vw-8rem,18rem)] sm:max-w-[22rem] items-center gap-2 rounded-lg bg-neutral-900/40 px-2.5 py-1.5">
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Experience</span>
                  <span className="min-w-0 truncate font-mono text-xs sm:text-sm font-medium tabular-nums text-emerald-400">
                    {activeBuilderExperienceName}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpenBuilderExperienceSignal((n) => n + 1)}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/70"
                  title="Browse and import a saved builder experience"
                  aria-label="Import builder experience"
                >
                  <Import className="h-3.5 w-3.5 shrink-0 opacity-90" aria-hidden />
                  <span className="hidden sm:inline">Import</span>
                </button>
              </div>
              <AnimatePresence>
                {builderSaveExperienceVisible && (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.8, x: -10 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.8, x: -10 }}
                    onClick={() => setSaveBuilderExperienceSignal((n) => n + 1)}
                    className="relative cursor-pointer px-3 py-1 bg-amber-500 hover:bg-amber-400 text-neutral-900 border border-amber-400 rounded-full shadow-[0_0_15px_rgba(245,158,11,0.5)] flex items-center gap-1.5 transition-all outline-none font-bold text-[10px] uppercase tracking-wider"
                    title={
                      activeBuilderExperienceName === 'Unsaved'
                        ? 'Save this solve as a new builder experience'
                        : 'Update the loaded builder experience on disk'
                    }
                  >
                    <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-100" />
                    </span>
                    <RefreshCw className="w-3 h-3" />{' '}
                    {activeBuilderExperienceName === 'Unsaved' ? 'SAVE' : 'UPDATE'}
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setGuidanceMode((v) => !v)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-semibold uppercase tracking-wider transition-colors ${
              guidanceMode
                ? 'border-blue-500/50 bg-blue-600/20 text-blue-300 hover:bg-blue-600/30'
                : 'border-neutral-700 bg-neutral-800/50 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/60'
            }`}
            title={guidanceMode ? 'Guidance mode on: tooltips enabled' : 'Guidance mode off: tooltips disabled'}
            aria-pressed={guidanceMode}
          >
            <CircleHelp className="w-3.5 h-3.5" />
            Guidance
          </button>
          <span className={`flex h-3 w-3 rounded-full ${data ? 'bg-emerald-500' : 'bg-red-500'} ${loading ? 'animate-pulse' : ''}`} />
          <span className="text-sm text-neutral-400">{data ? 'Connected' : 'Disconnected'}</span>
        </div>
      </header>

      {error && (
        <div className="shrink-0 mt-4 bg-red-900/50 border border-red-500 text-red-200 p-3 rounded-lg text-sm">{error}</div>
      )}

      {/* ─── TAB CONTENT ─── */}
      {activeTab === 'explorer' ? (
        <div className="flex-1 mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">

          {/* Panel 1: Parameters */}
          <motion.div layout className="lg:col-span-3 xl:col-span-2 min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 shadow-xl flex flex-col min-h-0">
            <div className="flex items-center gap-3 mb-6 min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Settings className="w-5 h-5 text-blue-500 shrink-0" />
                <h2 className="text-lg font-bold text-white uppercase tracking-tight truncate">Configuration</h2>
              </div>
              <div className="flex gap-2 shrink-0">
                <input type="file" ref={fileInputRef} onChange={handleLoadConfig} accept=".json" className="hidden" />
                <button onClick={handleSaveConfig}
                  className="p-2 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 transition-all border border-blue-600/50 flex items-center justify-center shadow-sm"
                  title="Save Configuration as New File">
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto pr-2 space-y-4 scrollbar-thin scrollbar-thumb-neutral-600 scrollbar-track-transparent">
              <div className="space-y-2 pb-2 border-b border-neutral-700/50">
                <label className={`text-sm font-medium tracking-tight flex items-center gap-2 ${isModified('note') ? 'text-amber-400' : 'text-neutral-300'}`}>
                  Note
                  {isModified('note') && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse hidden xl:block" />}
                </label>
                <textarea value={params.note} onChange={(e) => handleNoteChange(e.target.value)}
                  placeholder="Describe this profile..."
                  rows={3}
                  className={`w-full resize-y min-h-[4.5rem] rounded-lg border bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none focus:ring-2 focus:ring-blue-500/40 ${isModified('note') ? 'border-amber-500/50' : 'border-neutral-700'}`} />
              </div>

              <Accordion title="Cam & Actuator Geometry">
                <div className="space-y-5 pt-2">
                  <ParameterSlider label="Motor Speed" value={params.motor_speed} min={10} max={1000} step={10} onChange={(val) => handleParamChange('motor_speed', val)} isModified={isModified('motor_speed')} description={explorerMotorSpeed} />
                  <ParameterSlider label="Default Dist (mm)" value={params.default_distance} min={0.01} max={2.0} step={0.01} onChange={(val) => handleParamChange('default_distance', val)} isModified={isModified('default_distance')} description={explorerDefaultDist} />
                  <ParameterSlider label="Thickness (mm)" value={params.thickness} min={0.1} max={5.0} step={0.1} onChange={(val) => handleParamChange('thickness', val)} isModified={isModified('thickness')} description={explorerThickness} />
                  <ParameterSlider label="Height (mm)" value={params.height} min={0.01} max={8.0} step={0.01} onChange={(val) => handleParamChange('height', val)} isModified={isModified('height')} description={explorerHeight} />
                  <ParameterSlider label="Curve Gain (K)" value={params.K} min={0.1} max={10.0} step={0.1} onChange={(val) => handleParamChange('K', val)} isModified={isModified('K')} description={explorerK} />
                  <ParameterSlider label="Deadband (mm)" value={params.deadband} min={0.05} max={8.0} step={0.05} onChange={(val) => handleParamChange('deadband', val)} isModified={isModified('deadband')} description={explorerDeadband} />
                </div>
              </Accordion>

              <Accordion title="Pneumatic System">
                <div className="space-y-5 pt-2">
                  <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1.0} max={12.0} step={0.1} onChange={(val) => handleParamChange('tube_id', val)} isModified={isModified('tube_id')} description={explorerTubeId} />
                  <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1.0} max={16.0} step={0.1} onChange={(val) => handleParamChange('tube_od', val)} isModified={isModified('tube_od')} description={explorerTubeOd} />
                  <ParameterSlider label="Pressure (PSI)" value={params.input_pressure_psi} min={0.0} max={150.0} step={1.0}
                    onChange={(val) => handleParamChange('input_pressure_psi', val)}
                    secondaryValue={`${(params.input_pressure_psi * 6.89476).toFixed(3)} kPa`}
                    isModified={isModified('input_pressure_psi')}
                    description={explorerPressure}
                  />
                  <ParameterSlider label="Compliance" value={params.compliance} min={0.0} max={5.0} step={0.01}
                    onChange={(val) => handleParamChange('compliance', val)}
                    secondaryValue={`Opening: ${(params.compliance * params.input_pressure_psi * 0.00689476).toFixed(3)} mm`}
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
            </div>

            {stats && (
              <div className="shrink-0 mt-4 pt-4 border-t border-neutral-700 space-y-2">
                <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Derived Stats</h3>
                <StatRow label="Gap at Y=0" value={`${stats.gapAtY0.toFixed(3)} mm`} />
                <StatRow
                  label="Static flow @ Y=0.5 mm"
                  value={
                    stats.staticFlowAtHalfMm !== null
                      ? `${stats.staticFlowAtHalfMm.toFixed(3)} L/min`
                      : 'N/A'
                  }
                />
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
                <StatRow label="Max Flow (static)" value={`${stats.maxFlow.toFixed(3)} L/min`} />
                {stats.maxDynamicFlow !== undefined && (
                  <StatRow label="Max Flow (dynamic)" value={`${stats.maxDynamicFlow.toFixed(3)} L/min`} />
                )}
                {hasDynamicModel && (
                  <>
                    <StatRow label="Total Volume" value={`${stats.totalVolume.toFixed(2)} mL`} />
                    <StatRow label="Equalization" value={stats.equalizationTime >= 0 ? `${stats.equalizationTime.toFixed(1)} ms` : 'N/A'} />
                  </>
                )}
              </div>
            )}
          </motion.div>

          {/* Panel 2: Vertical System View */}
          <motion.div layout transition={{ duration: 0.5, ease: 'easeInOut' }} className={`min-w-0 bg-neutral-800 p-4 rounded-xl border border-neutral-700 shadow-xl flex flex-col min-h-0 ${detailsView ? 'lg:col-span-4 xl:col-span-4' : 'lg:col-span-2 xl:col-span-2'}`}>
            <VerticalSystemView data={data} params={params} details={detailsView} setDetails={setDetailsView} />
          </motion.div>

          {/* Panel 3: Charts Area */}
          <motion.div layout transition={{ duration: 0.5, ease: 'easeInOut' }} className={`relative min-w-0 grid grid-rows-3 gap-4 min-h-0 ${detailsView ? 'lg:col-span-5 xl:col-span-6' : 'lg:col-span-7 xl:col-span-8'}`}>
            <AnimatePresence>
              {maximizedChart && (
                <>
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    onClick={() => setMaximizedChart(null)} className="absolute -inset-4 z-40 rounded-xl bg-neutral-900/40" />
                  <motion.div layoutId={`card-${maximizedChart}`}
                    className="absolute inset-0 z-50 bg-neutral-800 rounded-xl border border-neutral-600 shadow-2xl flex flex-col items-stretch overflow-hidden">
                    <div className="flex justify-between items-center p-6 pb-2 border-b border-neutral-700/50 bg-neutral-800/80 backdrop-blur">
                      <h3 className="text-xl font-bold text-neutral-100">{maximizedInfo?.title}</h3>
                      <button onClick={() => setMaximizedChart(null)}
                        className="p-2 rounded-lg hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors focus:outline-none focus:ring-2 ring-blue-500">
                        <Minimize2 className="w-6 h-6" />
                      </button>
                    </div>
                    <div className="flex-1 w-full p-6">{maximizedInfo?.comp}</div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>

            <motion.div layoutId="card-pneumatic" className="row-span-2 bg-neutral-800 p-3 rounded-xl border border-neutral-700 shadow-xl flex flex-col items-stretch min-h-0">
              <div className="flex justify-between items-center mb-2 shrink-0 relative">
                <div className="absolute inset-0 flex items-center justify-center">
                  <h3 className="text-sm font-bold text-neutral-200 uppercase tracking-wider">Pneumatic Flow vs Y</h3>
                </div>
                <div className="z-10 w-full flex justify-end gap-1">
                  <button onClick={() => setChartSettingsTarget('pneumatic')}
                    className={`p-1.5 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'pneumatic' ? 'opacity-0' : isExplorerChartSettingsModified('pneumatic') ? 'text-amber-400 hover:text-amber-300' : 'text-neutral-400 hover:text-white'}`}
                    title="Chart settings">
                    <Cog className="w-4 h-4" />
                  </button>
                  <button onClick={() => setMaximizedChart('pneumatic')}
                    className={`p-1.5 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'pneumatic' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}>
                    <Maximize2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className={`flex-1 w-full min-h-0 ${maximizedChart === 'pneumatic' ? 'opacity-0' : 'opacity-100'}`}>
                {renderPneumatic()}
              </div>
            </motion.div>

            <div className="row-span-1 flex flex-col lg:flex-row gap-4 min-h-0">
              <motion.div layoutId="card-gapY" className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 shadow-xl flex flex-col items-stretch flex-1 min-h-0">
                <div className="flex justify-between items-center mb-2 shrink-0 relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <h3 className="text-xs font-bold text-neutral-400 lg:text-neutral-200 uppercase tracking-wider">Gap vs Y</h3>
                  </div>
                  <div className="z-10 w-full flex justify-end gap-1">
                    <button onClick={() => setChartSettingsTarget('gapY')}
                      className={`p-1 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'gapY' ? 'opacity-0' : isExplorerChartSettingsModified('gapY') ? 'text-amber-400 hover:text-amber-300' : 'text-neutral-400 hover:text-white'}`}
                      title="Chart settings">
                      <Cog className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setMaximizedChart('gapY')}
                      className={`p-1 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'gapY' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}>
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className={`flex-1 w-full min-h-0 ${maximizedChart === 'gapY' ? 'opacity-0' : 'opacity-100'}`}>{renderGapY()}</div>
              </motion.div>

              <motion.div layoutId="card-gapTime" className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 shadow-xl flex flex-col items-stretch flex-1 min-h-0">
                <div className="flex justify-between items-center mb-2 shrink-0 relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <h3 className="text-xs font-bold text-neutral-400 lg:text-neutral-200 uppercase tracking-wider">Gap vs Time</h3>
                  </div>
                  <div className="z-10 w-full flex justify-end gap-1">
                    <button onClick={() => setChartSettingsTarget('gapTime')}
                      className={`p-1 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'gapTime' ? 'opacity-0' : isExplorerChartSettingsModified('gapTime') ? 'text-amber-400 hover:text-amber-300' : 'text-neutral-400 hover:text-white'}`}
                      title="Chart settings">
                      <Cog className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setMaximizedChart('gapTime')}
                      className={`p-1 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'gapTime' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}>
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className={`flex-1 w-full min-h-0 ${maximizedChart === 'gapTime' ? 'opacity-0' : 'opacity-100'}`}>{renderGapTime()}</div>
              </motion.div>
            </div>
          </motion.div>
        </div>
      ) : (
        <ProfileBuilder
          onApplyToExplorer={handleApplyFromBuilder}
          explorerCompliance={params.compliance}
          guidanceEnabled={guidanceMode}
          onActiveExperienceNameChange={setActiveBuilderExperienceName}
          openExperienceBrowserSignal={openBuilderExperienceSignal}
          onDirtyStateChange={setBuilderSaveExperienceVisible}
          saveExperienceSignal={saveBuilderExperienceSignal}
        />
      )}

      <ChartDomainSettingsModal
        isOpen={chartSettingsTarget !== null}
        title={chartSettingsTarget ? `${chartSettingsTarget} domain settings` : 'Domain settings'}
        settings={chartSettingsTarget ? getExplorerChartSettings(chartSettingsTarget) : DEFAULT_DOMAIN}
        onClose={() => setChartSettingsTarget(null)}
        onChange={(next) => {
          if (!chartSettingsTarget) return;
          setExplorerChartSettings(chartSettingsTarget, next);
        }}
      />

      {/* Modals & Overlays */}
      <ConfigModal
        isOpen={showImportModal} onClose={() => setShowImportModal(false)} configs={configs}
        onHoverConfig={loadConfigData} onSelectConfig={setSelectedConfig} onOpenConfig={handleOpenConfigByName}
        onDeleteConfig={handleDeleteConfig} onSetDefault={handleSetDefault} selectedConfig={selectedConfig}
        defaultConfig={defaultConfig} previewParams={previewParams} previewData={previewData} onApply={handleApplyConfig}
      />

      <AnimatePresence>
        {toast.visible && (
          <motion.div initial={{ opacity: 0, y: 50, scale: 0.9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-neutral-800 border-2 border-blue-500/50 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-xl">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-sm font-bold tracking-tight">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
    </TooltipHintsProvider>
  );
}
