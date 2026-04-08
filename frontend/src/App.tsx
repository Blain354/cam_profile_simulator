import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Label
} from 'recharts';
import { 
  Settings, Maximize2, Minimize2, 
  ChevronDown, ChevronRight, Info, Trash2, 
  Import, Download, X, RefreshCw 
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface SimulationParams {
  motor_speed: number;
  height: number;
  thickness: number;
  K: number;
  deadband: number;
  default_distance: number;
  bushing_diameter: number;
  lead_screw_pitch: number;
  tube_id: number;
  tube_od: number;
  input_pressure_psi: number;
  compliance: number;
}

interface SimulationResult {
  cam_X: number[];
  cam_Y: number[];
  Y_positions: number[];
  min_gaps: number[];
  flow_area: number[];
  flow_l_min: number[];
  time_axis_ms: number[];
  gap_at_Y0: number;
  default_distance: number;
  deadband: number;
  height: number;
  linear_speed_mm_s: number;
  ctrl_length: number;
  Y_start: number;
  Y_end: number;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';
const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const defaultParams: SimulationParams = {
  motor_speed: 100,
  height: 2.0,
  thickness: 2.5,
  K: 2.0,
  deadband: 1.5,
  default_distance: 0.35,
  bushing_diameter: 3.0,
  lead_screw_pitch: 0.5,
  tube_id: 2.0,
  tube_od: 3.0,
  input_pressure_psi: 30.0,
  compliance: 0.7,
};

export default function App() {
  const [params, setParams] = useState<SimulationParams>(defaultParams);
  const [savedParams, setSavedParams] = useState<SimulationParams | null>(null);
  const [data, setData] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maximizedChart, setMaximizedChart] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [configs, setConfigs] = useState<string[]>([]);
  const [defaultConfig, setDefaultConfig] = useState<string | null>(null);
  const [activeConfigName, setActiveConfigName] = useState<string>("Default");
  const [previewParams, setPreviewParams] = useState<SimulationParams | null>(null);
  const [previewData, setPreviewData] = useState<SimulationResult | null>(null);
  const [selectedConfig, setSelectedConfig] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string, visible: boolean }>({ message: "", visible: false });
  const [globalTooltip, setGlobalTooltip] = useState<{content: React.ReactNode, rect: DOMRect} | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = (message: string) => {
    setToast({ message, visible: true });
    setTimeout(() => setToast({ message: "", visible: false }), 3000);
  };

  const fetchConfigs = async () => {
    try {
      const res = await fetch(apiUrl('/api/configs'));
      const listData = await res.json();
      setConfigs(listData.configs);
      
      const defRes = await fetch(apiUrl('/api/configs/default'));
      const defData = await defRes.json();
      setDefaultConfig(defData.default);
    } catch (err) {
      console.error("Error fetching configs:", err);
    }
  };

  useEffect(() => {
    // 1. Fetch entire list of configs
    fetchConfigs();

    // 2. Load default config on startup
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/configs/default'));
        const data = await res.json();
        if (data.default && data.default !== "none") {
          const configRes = await fetch(apiUrl(`/api/configs/${data.default}`));
          if (configRes.ok) {
            const configParams = await configRes.json();
            setParams(configParams);
            setSavedParams(configParams);
            setDefaultConfig(data.default);
            setActiveConfigName(data.default);
            showToast(`Startup profile loaded: ${data.default}`);
          }
        }
      } catch (err) {
        console.error("Error loading default config:", err);
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

  const loadConfigData = async (name: string) => {
    try {
      const res = await fetch(apiUrl(`/api/configs/${name}`));
      const configParams = await res.json();
      setPreviewParams(configParams);

      // Perform real simulation for preview
      const simRes = await fetch(apiUrl('/api/simulate'), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configParams),
      });
      const simResult = await simRes.json();
      setPreviewData(simResult);
    } catch (err) {
      console.error("Error loading config:", err);
    }
  };

  const handleSetDefault = async (name: string) => {
    try {
      await fetch(apiUrl(`/api/configs/default/${name}`), { method: "POST" });
      setDefaultConfig(name);
    } catch (err) {
      console.error("Error setting default config:", err);
    }
  };

  const handleDeleteConfig = async (name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to delete ${name}?`)) return;
    try {
      if (defaultConfig === name) {
         await fetch(apiUrl('/api/configs/default/none'), { method: "POST" });
         setDefaultConfig(null);
      }
      await fetch(apiUrl(`/api/configs/${name}`), { method: "DELETE" });
      if (selectedConfig === name) {
        setSelectedConfig(null);
        setPreviewParams(null);
        setPreviewData(null);
      }
      fetchConfigs();
    } catch (err) {
      console.error("Error deleting config:", err);
    }
  };

  const handleSaveConfig = async () => {
    try {
      const res = await fetch(apiUrl('/api/save-config'), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      setActiveConfigName(data.filename);
      setSavedParams(params);
      showToast("Simulation Config Saved to Repo");
      fetchConfigs();
    } catch (err) {
      console.error("Error saving config:", err);
      showToast("Error saving config");
    }
  };

  const handleUpdateConfig = async () => {
    try {
      if (activeConfigName === "Default" || !activeConfigName.endsWith(".json")) {
         return handleSaveConfig();
      }
      await fetch(apiUrl(`/api/configs/${activeConfigName}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      setSavedParams(params);
      showToast(`Profile ${activeConfigName} updated`);
      fetchConfigs();
    } catch (err) {
      console.error("Error updating config:", err);
      showToast("Error updating config");
    }
  };

  const handleLoadConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        setParams(json);
        setSavedParams(json);
      } catch (err) {
        console.error("Failed to parse JSON:", err);
        alert("Invalid JSON file");
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };
  const [detailsView, setDetailsView] = useState(false);

  const fetchSimulation = useCallback(async (currentParams: SimulationParams) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(apiUrl('/api/simulate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentParams),
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const result = await response.json();
      setData(result);
    } catch (e) {
      console.error("Failed to fetch simulation:", e);
      setError("Failed to connect to backend. Is the FastAPI server running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSimulation(params);
    }, 100);
    return () => clearTimeout(timer);
  }, [params, fetchSimulation]);

  const handleParamChange = (key: keyof SimulationParams, value: number) => {
    setParams(prev => ({ ...prev, [key]: value }));
  };

  const hasChanges = useMemo(() => savedParams ? JSON.stringify(params) !== JSON.stringify(savedParams) : false, [params, savedParams]);
  const isModified = useCallback((key: keyof SimulationParams) => savedParams ? params[key] !== savedParams[key] : false, [params, savedParams]);

  const gapVsYData = useMemo(() => data?.Y_positions.map((y, i) => ({ y, gap: data.min_gaps[i] })) || [], [data]);
  const gapVsTimeData = useMemo(() => data?.time_axis_ms.map((t, i) => ({ time: t, gap: data.min_gaps[i], flow: data.flow_l_min[i] })) || [], [data]);
  
  const pneumaticData = useMemo(() => {
    if (!data) return [];
    
    // Find time at Y=0 to make time relative
    // Since Y axis is linear with time, we can find t0 where y=0
    let t0 = 0;
    const yArr = data.Y_positions;
    const tArr = data.time_axis_ms;
    for (let i = 0; i < yArr.length - 1; i++) {
       if ((yArr[i] <= 0 && yArr[i+1] >= 0) || (yArr[i] >= 0 && yArr[i+1] <= 0)) {
           // Linear interpolation to find t at y=0
           const ratio = (0 - yArr[i]) / (yArr[i+1] - yArr[i]);
           t0 = tArr[i] + ratio * (tArr[i+1] - tArr[i]);
           break;
       }
    }

    return data.Y_positions.map((y, i) => ({ 
      y, 
      flow: data.flow_l_min[i], 
      gap: data.min_gaps[i], 
      time: data.time_axis_ms[i] - t0 
    }));
  }, [data]);

  const stats = useMemo(() => {
    if (!data) return null;
    
    // Find time where Y crosses 0
    let t0 = 0;
    const yArr = data.Y_positions;
    const tArr = data.time_axis_ms;
    for (let i = 0; i < yArr.length; i++) {
        if (yArr[i] >= 0) {
            t0 = tArr[i];
            break;
        }
    }

    // Find first time where flow > 0.1 L/min
    let tOpen = 0;
    const fArr = data.flow_l_min;
    for (let i = 0; i < fArr.length; i++) {
        if (fArr[i] > 0.1) {
            tOpen = tArr[i];
            break;
        }
    }

    const openTime = Math.max(0, tOpen - t0);

    return {
      gapAtY0: data.gap_at_Y0,
      openTime: openTime,
      maxFlow: Math.max(...data.flow_l_min),
    };
  }, [data]);

  // Content renderers for each chart type
  const renderGapY = () => (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={220}>
      <LineChart data={gapVsYData} margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#333" />
        <XAxis dataKey="y" type="number" domain={[-1.5, data ? Math.max(data.deadband, data.ctrl_length) : 4]} allowDataOverflow={true} stroke="#888" label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888' }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Gap (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={['dataMin - 0.1', 'dataMax + 0.1']} tickFormatter={(val) => val.toFixed(3)} />
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
        <XAxis dataKey="time" type="number" domain={['auto', 'auto']} stroke="#888" label={{ value: 'Time (ms)', position: 'bottom', fill: '#888' }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Gap (mm)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={['dataMin - 0.1', 'dataMax + 0.1']} tickFormatter={(val) => val.toFixed(3)} />
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
        <XAxis dataKey="y" type="number" domain={[-1.5, data ? Math.max(data.deadband, data.ctrl_length) : 4]} allowDataOverflow={true} stroke="#888" label={{ value: 'Y Position (mm)', position: 'bottom', fill: '#888' }} tickFormatter={(val) => val.toFixed(3)} />
        <YAxis type="number" stroke="#888" label={{ value: 'Flow (L/min)', angle: -90, position: 'insideLeft', fill: '#888', offset: 10 }} domain={[0, 'auto']} tickFormatter={(val) => val.toFixed(3)} />
        <Tooltip 
          contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '12px', padding: '12px 16px' }} 
          separator=""
          formatter={(value: any, name?: any, props?: any) => {
            if (name === "Pneumatic Flow") {
              const payload = props?.payload;
              return [
                <div key="flow-tip" className="flex flex-col gap-1.5">
                  <div className="flex justify-between gap-6">
                    <span className="text-amber-500 font-black text-2xl tracking-tight">{Number(value).toFixed(3)} L/min</span>
                  </div>
                  {payload && (
                    <div className="text-base text-neutral-400 flex flex-col mt-2 border-t border-neutral-700/50 pt-2 space-y-1">
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
                null
              ];
            }
            // Return null for "gap" line as it's already in the flow-tip
            if (name === "gap") return [null, null];
            return [value, ""];
          }}
          labelFormatter={(label: any) => `Y: ${Number(label).toFixed(3)} mm`}
        />
        {data && (
          <>


          </>
        )}
        <Line type="monotone" dataKey="flow" name="Pneumatic Flow" stroke="#f59e0b" strokeWidth={3} dot={false} isAnimationActive={false} />
        <Line type="monotone" dataKey="gap" name="gap" stroke="#3b82f6" strokeWidth={0} strokeOpacity={0} dot={false} activeDot={false} isAnimationActive={false} legendType="none" />
        <ReferenceLine x={0} stroke="white" strokeDasharray="5 5" strokeWidth={3}>
          {maximizedChart === 'pneumatic' && <Label value="BUSHING CENTER (0mm)" position="insideTopLeft" fill="white" fontSize={12} fontWeight="bold" offset={15} />}
        </ReferenceLine>
      </LineChart>
    </ResponsiveContainer>
  );

  const getChartContent = (id: string | null) => {
    switch(id) {
      case 'gapY': return { title: "Gap vs Y Position", comp: renderGapY() };
      case 'gapTime': return { title: "Gap vs Time", comp: renderGapTime() };
      case 'pneumatic': return { title: "Pneumatic Flow vs Y", comp: renderPneumatic() };
      default: return null;
    }
  };

  const maximizedInfo = getChartContent(maximizedChart);

  return (
    <div className="h-screen w-full bg-neutral-900 text-neutral-100 p-4 font-sans overflow-hidden flex flex-col">
      
      <header className="shrink-0 flex justify-between items-center pb-3 border-b border-neutral-800">
        <div>
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent leading-tight hidden lg:block">
              Cam Profile Simulator
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <div className={`bg-neutral-800/80 border ${hasChanges ? 'border-amber-500/50' : 'border-neutral-700'} px-3 py-1 rounded-full flex items-center gap-2 shadow-inner transition-colors`}>
                 <span className="text-[10px] text-neutral-500 uppercase font-black tracking-tighter">Profile:</span>
                 <span className={`text-sm font-mono font-medium ${hasChanges ? 'text-amber-400' : 'text-emerald-400'}`}>
                   {activeConfigName}{hasChanges ? '*' : ''}
                 </span>
              </div>
              <AnimatePresence>
                {hasChanges && (
                  <motion.button 
                    initial={{ opacity: 0, scale: 0.8, x: -10 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.8, x: -10 }}
                    onClick={handleUpdateConfig}
                    className="relative cursor-pointer px-3 py-1 bg-amber-500 hover:bg-amber-400 text-neutral-900 border border-amber-400 rounded-full shadow-[0_0_15px_rgba(245,158,11,0.5)] flex items-center gap-1.5 transition-all outline-none font-bold text-[10px] uppercase tracking-wider"
                    title="Update currently loaded config"
                  >
                    <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-yellow-100"></span>
                    </span>
                    <RefreshCw className="w-3 h-3" />
                    UPDATE
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </div>
          <p className="text-xs text-neutral-400 mt-1">Pneumatic valve opening simulation</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`flex h-3 w-3 rounded-full ${data ? 'bg-emerald-500' : 'bg-red-500'} ${loading ? 'animate-pulse' : ''}`}></span>
          <span className="text-sm text-neutral-400">{data ? 'Connected' : 'Disconnected'}</span>
        </div>
      </header>

      {error && (
        <div className="shrink-0 mt-4 bg-red-900/50 border border-red-500 text-red-200 p-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Main Grid: strictly height constrained */}
      <div className="flex-1 mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4 relative min-h-0">
        
        {/* Panel 1: Parameters (3/12 columns) */}
        <motion.div layout className="lg:col-span-3 xl:col-span-2 bg-neutral-800 p-4 rounded-xl border border-neutral-700 shadow-xl flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-blue-500" />
                <h2 className="text-lg font-bold text-white uppercase tracking-tight">Configuration</h2>
              </div>
              <div className="flex gap-2">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleLoadConfig} 
                  accept=".json" 
                  className="hidden" 
                />
                <button 
                  onClick={() => {
                    fetchConfigs();
                    setShowImportModal(true);
                  }}
                  className="p-2 rounded-lg bg-neutral-700 hover:bg-neutral-600 text-neutral-200 transition-all border border-neutral-600 flex items-center justify-center shadow-sm"
                  title="Import JSON Config from Repo"
                >
                  <Import className="w-4 h-4" />
                </button>
                <button 
                  onClick={handleSaveConfig}
                  className="p-2 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 transition-all border border-blue-600/50 flex items-center justify-center shadow-sm"
                  title="Save Configuration as New File"
                >
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </div>
          
          <div className="flex-1 overflow-y-auto pr-2 space-y-4 scrollbar-thin scrollbar-thumb-neutral-600 scrollbar-track-transparent">
            <Accordion title="Cam & Actuator Geometry">
              <div className="space-y-5 pt-2">
                <ParameterSlider label="Motor Speed" value={params.motor_speed} min={10} max={1000} step={10} onChange={(val) => handleParamChange('motor_speed', val)} isModified={isModified('motor_speed')} />
                <ParameterSlider label="Default Dist (mm)" value={params.default_distance} min={0.01} max={2.0} step={0.01} onChange={(val) => handleParamChange('default_distance', val)} isModified={isModified('default_distance')} />
                <ParameterSlider label="Thickness (mm)" value={params.thickness} min={0.1} max={5.0} step={0.1} onChange={(val) => handleParamChange('thickness', val)} isModified={isModified('thickness')} />
                <ParameterSlider label="Height (mm)" value={params.height} min={0.01} max={8.0} step={0.01} onChange={(val) => handleParamChange('height', val)} isModified={isModified('height')} />
                <ParameterSlider label="Curve Gain (K)" value={params.K} min={0.1} max={10.0} step={0.1} onChange={(val) => handleParamChange('K', val)} isModified={isModified('K')} />
                <ParameterSlider label="Deadband (mm)" value={params.deadband} min={0.05} max={8.0} step={0.05} onChange={(val) => handleParamChange('deadband', val)} isModified={isModified('deadband')} />
              </div>
            </Accordion>

            <Accordion title="Pneumatic System">
              <div className="space-y-5 pt-2">
                <ParameterSlider label="Tube ID (mm)" value={params.tube_id} min={1.0} max={12.0} step={0.1} onChange={(val) => handleParamChange('tube_id', val)} isModified={isModified('tube_id')} />
                <ParameterSlider label="Tube OD (mm)" value={params.tube_od} min={1.0} max={16.0} step={0.1} onChange={(val) => handleParamChange('tube_od', val)} isModified={isModified('tube_od')} />
                <ParameterSlider 
                  label="Pressure (PSI)" 
                  value={params.input_pressure_psi} 
                  min={0.0} max={150.0} step={1.0} 
                  onChange={(val) => handleParamChange('input_pressure_psi', val)}
                  secondaryValue={`${(params.input_pressure_psi * 6.89476).toFixed(3)} kPa`}
                  isModified={isModified('input_pressure_psi')}
                />
                <ParameterSlider 
                  label="Compliance" 
                  value={params.compliance} 
                  min={0.0} max={2.0} step={0.01} 
                  onChange={(val) => handleParamChange('compliance', val)}
                  secondaryValue={`Opening: ${(params.compliance * params.input_pressure_psi * 0.00689476).toFixed(3)} mm`}
                  isModified={isModified('compliance')}
                  setGlobalTooltip={setGlobalTooltip}
                  tooltip={
                    <div className="space-y-2 text-left tracking-normal font-sans">
                      <p><strong className="text-blue-400 block mb-1 uppercase tracking-wider text-[10px]">Compliance Factor (mm/MPa)</strong></p>
                      <p className="text-neutral-300 leading-relaxed mb-2">Replaces the obsolete "Shore A" scalar measurement with a <strong className="text-white">direct & empirical</strong> elastic value.</p>
                      <ul className="list-disc pl-3 space-y-1.5 text-neutral-400 marker:text-neutral-600">
                        <li>Indicates the radial expansion of the silicone tube for every MegaPascal (MPa) of internal air pressure.</li>
                        <li>The <span className="font-mono text-[10px] text-amber-200 bg-amber-500/10 px-1 py-0.5 rounded">Opening (X mm)</span> metric calculated to the right represents the <strong>absolute static swelling</strong> of the tube at the currently configured input pressure. <br/><br/><span className="italic text-neutral-500 text-[10px]">This is the exact structural gap distance that must be reached for choked air flow to begin.</span></li>
                      </ul>
                    </div>
                  }
                />
              </div>
            </Accordion>
          </div>

          {stats && (
            <div className="shrink-0 mt-4 pt-4 border-t border-neutral-700 space-y-2">
              <h3 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Derived Stats</h3>
              <StatRow label="Gap at Y=0" value={`${stats.gapAtY0.toFixed(3)} mm`} />
              <StatRow 
                label="Open Latency" 
                value={
                  <div className="flex items-center gap-1.5">
                    <span>{stats.openTime.toFixed(3)} ms</span>
                    <span className="text-[10px] text-neutral-500 font-normal">
                      ({((params.motor_speed * params.lead_screw_pitch / 60) * (stats.openTime / 1000)).toFixed(3)} mm)
                    </span>
                  </div>
                } 
                highlight={true} 
              />
              <StatRow label="Max Flow" value={`${stats.maxFlow.toFixed(3)} L/min`} />
            </div>
          )}
        </motion.div>

        {/* Panel 2: Vertical System View */}
        <motion.div layout transition={{ duration: 0.5, ease: "easeInOut" }} className={`bg-neutral-800 p-4 rounded-xl border border-neutral-700 shadow-xl flex flex-col min-h-0 ${detailsView ? 'lg:col-span-4 xl:col-span-4' : 'lg:col-span-2 xl:col-span-2'}`}>
          <VerticalSystemView data={data} params={params} details={detailsView} setDetails={setDetailsView} />
        </motion.div>

        {/* Panel 3: Charts Area */}
        <motion.div layout transition={{ duration: 0.5, ease: "easeInOut" }} className={`relative grid grid-rows-3 gap-4 min-h-0 ${detailsView ? 'lg:col-span-5 xl:col-span-6' : 'lg:col-span-7 xl:col-span-8'}`}>
            
            {/* Maximized Chart Modal Overlay (Scoped to Charts Area) */}
            <AnimatePresence>
              {maximizedChart && (
                <>
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setMaximizedChart(null)}
                    className="absolute -inset-4 bg-black/50 z-40 backdrop-blur-sm rounded-xl"
                  />
                  <motion.div 
                    layoutId={`card-${maximizedChart}`}
                    className="absolute inset-0 z-50 bg-neutral-800 rounded-xl border border-neutral-600 shadow-2xl flex flex-col items-stretch overflow-hidden"
                  >
                    <div className="flex justify-between items-center p-6 pb-2 border-b border-neutral-700/50 bg-neutral-800/80 backdrop-blur">
                      <h3 className="text-xl font-bold text-neutral-100">{maximizedInfo?.title}</h3>
                      <button 
                        onClick={() => setMaximizedChart(null)} 
                        className="p-2 rounded-lg hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors focus:outline-none focus:ring-2 ring-blue-500"
                      >
                        <Minimize2 className="w-6 h-6" />
                      </button>
                    </div>
                    <div className="flex-1 w-full p-6">
                      {maximizedInfo?.comp}
                    </div>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
            
            {/* Pneumatic Area vs Y Position (Top 2/3) */}
            <motion.div layoutId="card-pneumatic" className="row-span-2 bg-neutral-800 p-3 rounded-xl border border-neutral-700 shadow-xl flex flex-col items-stretch min-h-0">
              <div className="flex justify-between items-center mb-2 shrink-0 relative">
                <div className="absolute inset-0 flex items-center justify-center">
                  <h3 className="text-sm font-bold text-neutral-200 uppercase tracking-wider">Pneumatic Flow vs Y</h3>
                </div>
                <div className="z-10 w-full flex justify-end">
                  <button 
                    onClick={() => setMaximizedChart('pneumatic')} 
                    className={`p-1.5 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'pneumatic' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className={`flex-1 w-full min-h-0 ${maximizedChart === 'pneumatic' ? 'opacity-0' : 'opacity-100'}`}>
                {renderPneumatic()}
              </div>
            </motion.div>

            {/* Bottom row (1/3) with Gap charts side-by-side */}
            <div className="row-span-1 flex flex-col lg:flex-row gap-4 min-h-0">
               {/* Gap vs Y Position */}
               <motion.div layoutId="card-gapY" className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 shadow-xl flex flex-col items-stretch flex-1 min-h-0">
                <div className="flex justify-between items-center mb-2 shrink-0 relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <h3 className="text-xs font-bold text-neutral-400 lg:text-neutral-200 uppercase tracking-wider">Gap vs Y</h3>
                  </div>
                  <div className="z-10 w-full flex justify-end">
                    <button 
                      onClick={() => setMaximizedChart('gapY')} 
                      className={`p-1 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'gapY' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className={`flex-1 w-full min-h-0 ${maximizedChart === 'gapY' ? 'opacity-0' : 'opacity-100'}`}>
                  {renderGapY()}
                </div>
              </motion.div>

              {/* Gap vs Time */}
              <motion.div layoutId="card-gapTime" className="bg-neutral-800 p-3 rounded-xl border border-neutral-700 shadow-xl flex flex-col items-stretch flex-1 min-h-0">
                <div className="flex justify-between items-center mb-2 shrink-0 relative">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <h3 className="text-xs font-bold text-neutral-400 lg:text-neutral-200 uppercase tracking-wider">Gap vs Time</h3>
                  </div>
                  <div className="z-10 w-full flex justify-end">
                    <button 
                      onClick={() => setMaximizedChart('gapTime')} 
                      className={`p-1 rounded-md hover:bg-neutral-700 transition-colors focus:outline-none focus:ring-2 ring-blue-500 ${maximizedChart === 'gapTime' ? 'opacity-0' : 'text-neutral-400 hover:text-white'}`}
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className={`flex-1 w-full min-h-0 ${maximizedChart === 'gapTime' ? 'opacity-0' : 'opacity-100'}`}>
                  {renderGapTime()}
                </div>
              </motion.div>
            </div>
            
        </motion.div>
      </div>

      <ConfigModal 
        isOpen={showImportModal} 
        onClose={() => setShowImportModal(false)}
        configs={configs}
        onHoverConfig={loadConfigData}
        onSelectConfig={setSelectedConfig}
        onDeleteConfig={handleDeleteConfig}
        onSetDefault={handleSetDefault}
        selectedConfig={selectedConfig}
        defaultConfig={defaultConfig}
        previewParams={previewParams}
        previewData={previewData}
        onApply={handleApplyConfig}
      />

      {/* Persistence Toast Notification */}
      <AnimatePresence>
        {toast.visible && (
          <motion.div 
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 50, scale: 0.9 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[200] bg-neutral-800 border-2 border-blue-500/50 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 backdrop-blur-xl"
          >
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <span className="text-sm font-bold tracking-tight">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {globalTooltip && (() => {
          const tooltipWidth = 288; // w-72 = 18rem = 288px
          const tooltipHeight = 200; // estimated max height
          
          const spaceRight = window.innerWidth - globalTooltip.rect.right;
          const showLeft = spaceRight < tooltipWidth + 30;
          const left = showLeft ? globalTooltip.rect.left - tooltipWidth - 15 : globalTooltip.rect.right + 15;
          
          let top = globalTooltip.rect.top - 10;
          if (top + tooltipHeight > window.innerHeight) {
             top = Math.max(10, window.innerHeight - tooltipHeight - 20);
          }

          return (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, x: showLeft ? 10 : -10 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.95, x: showLeft ? 10 : -10 }}
              transition={{ duration: 0.15 }}
              style={{ 
                position: 'fixed', 
                top: top, 
                left: left,
                zIndex: 99999
              }}
              className="w-72 p-4 bg-neutral-900/95 border border-neutral-700 text-neutral-200 text-xs rounded-xl shadow-[0_0_30px_rgba(0,0,0,0.5)] pointer-events-none backdrop-blur-md"
            >
              {globalTooltip.content}
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}

function Accordion({ title, children, defaultOpen = true }: { title: string, children: React.ReactNode, defaultOpen?: boolean }) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-700/50 pb-2">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between py-2 text-sm font-semibold text-neutral-400 hover:text-neutral-200 transition-colors"
      >
        <span>{title}</span>
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ParameterSlider({ label, value, min, max, step, onChange, secondaryValue, isModified, tooltip, setGlobalTooltip }: { label: string, value: number, min: number, max: number, step: number, onChange: (val: number) => void, secondaryValue?: string, isModified?: boolean, tooltip?: React.ReactNode, setGlobalTooltip?: any }) {
  return (
    <div className="space-y-2 relative">
      <div className="flex justify-between items-center">
        <label className={`text-sm tracking-tight flex items-center gap-2 ${isModified ? 'text-amber-400 font-bold' : 'text-neutral-300 font-medium'}`}>
          {label}
          {tooltip && (
            <div className="relative flex items-center">
              <Info 
                onMouseEnter={(e) => setGlobalTooltip?.({ content: tooltip, rect: e.currentTarget.getBoundingClientRect() })}
                onMouseLeave={() => setGlobalTooltip?.(null)}
                className="w-4 h-4 text-blue-500/60 hover:text-blue-400 cursor-pointer transition-colors" 
              />
            </div>
          )}
          {isModified && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse hidden xl:block" />}
          {secondaryValue && <span className={`ml-2 text-xs font-normal ${isModified ? 'text-amber-500/70' : 'text-neutral-500'}`}>({secondaryValue})</span>}
        </label>
        <input 
          type="number" 
          value={value} 
          min={min} 
          max={max} 
          step={step} 
          onChange={(e) => {
             const v = parseFloat(e.target.value);
             if (!isNaN(v)) onChange(v);
          }}
          className="w-20 bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-xs text-right text-neutral-100 focus:outline-none focus:border-blue-500 font-mono"
        />
      </div>
      <input 
        type="range" 
        min={min} 
        max={max} 
        step={step} 
        value={value} 
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500 hover:accent-blue-400 transition-all cursor-pointer"
      />
    </div>
  );
}

function StatRow({ label, value, highlight = false }: { label: string, value: React.ReactNode, highlight?: boolean }) {
  return (
    <div className="flex justify-between items-center bg-neutral-900/50 p-2 rounded">
      <span className="text-sm text-neutral-400">{label}</span>
      <span className={`text-sm font-mono font-medium ${highlight ? 'text-fuchsia-400' : 'text-neutral-200'}`}>{value}</span>
    </div>
  );
}

function VerticalSystemView({ data, params, details, setDetails, isPreview = false }: { data: SimulationResult | null, params: SimulationParams, details: boolean, setDetails: (val: boolean) => void, isPreview?: boolean }) {
  if (!data) return <div className="animate-pulse bg-neutral-900/60 w-full h-full rounded-lg" />;

  const r = params.bushing_diameter / 2;
  const flatCamX = r + params.default_distance;
  const maxCamX = Math.max(...data.cam_X);
  
  // Tighter bound for maximum zoom on mechanism, with enough room for annotations
  const minX = details ? -r - 0.6 : -r - 0.4;
  const maxX = details ? maxCamX + 1.0 : maxCamX + 0.4;
  const minY = (details || isPreview) ? -params.deadband - r - 1.2 : -params.deadband - r - 0.4;
  const maxY = (details || isPreview) ? params.height + r + 1.2 : params.height + r + 0.4;

  const w = maxX - minX;
  const h = maxY - minY;

  const camPoints = data.cam_X.map((x, i) => `${x},${data.cam_Y[i]}`).join(' ');

  // Bushing is fixed at X=0 in the mechanism
  const cx = 0;
  const cy = 0;

  return (
    <div className={`w-full h-full flex flex-col relative overflow-hidden ${isPreview ? 'pointer-events-none' : ''}`}>
      {!isPreview && (
        <div className="flex justify-between items-center mb-4 shrink-0">
          <h3 className="text-sm font-semibold text-neutral-300 uppercase tracking-wide">
            Vertical System
          </h3>
          <button 
            onClick={() => setDetails(!details)}
            className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors border shadow-sm ${details ? 'bg-blue-600 border-blue-500 text-white shadow-blue-500/20' : 'bg-neutral-800 border-neutral-600 text-neutral-400 hover:bg-neutral-700 hover:text-white'}`}
          >
            {details ? "Hide Details" : "Details"}
          </button>
        </div>
      )}

      <div className={`flex-1 w-full bg-neutral-900/60 rounded-lg border border-neutral-800/80 overflow-hidden relative ${isPreview ? 'rounded-xl border-blue-500/30' : ''}`}>
        <motion.svg 
          initial={false}
          animate={{ viewBox: `${minX} ${minY} ${w} ${h}` }} 
          transition={{ duration: 0.5, ease: "easeInOut" }}
          preserveAspectRatio="xMidYMid meet" 
          className="w-full h-full scale-y-[-1]"
        >
          
          <motion.rect 
            initial={false}
            animate={{ x: minX, y: minY, width: w, height: h }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
            fill="#171717" 
          />
          
          {/* Axis markers for origin reference */}
          <motion.path 
            initial={false}
            animate={{ d: `M ${minX} ${0} L ${maxX} ${0}` }} 
            transition={{ duration: 0.5, ease: "easeInOut" }}
            stroke="#374151" strokeWidth="0.05" strokeDasharray="0.1 0.1" 
          />
          <motion.path 
            initial={false}
            animate={{ d: `M ${0} ${minY} L ${0} ${maxY}` }} 
            transition={{ duration: 0.5, ease: "easeInOut" }}
            stroke="#374151" strokeWidth="0.05" strokeDasharray="0.1 0.1" 
          />
          
          {/* Cam Profile */}
          <polyline points={camPoints} fill="none" stroke="#10b981" strokeWidth="0.08" strokeLinejoin="round" />
          
          {/* Single Bushing at Y=0, fixed X=0 */}
          <circle cx={cx} cy={cy} r={r} fill="#8b5cf6" fillOpacity={details ? 0.3 : 0.1} stroke="#8b5cf6" strokeWidth="0.08" opacity={0.8} />

          {/* Details / Dimension Traces */}
          {details && (
            <g>
              {/* Deadband Arrow */}
              <line x1={flatCamX - 0.2} y1={-params.deadband/2} x2={flatCamX - 0.2} y2={params.deadband/2} stroke="#ef4444" strokeWidth="0.03" />
              <line x1={flatCamX - 0.4} y1={-params.deadband/2} x2={flatCamX} y2={-params.deadband/2} stroke="#ef4444" strokeWidth="0.05" />
              <line x1={flatCamX - 0.4} y1={params.deadband/2} x2={flatCamX} y2={params.deadband/2} stroke="#ef4444" strokeWidth="0.05" />
              <g transform="scale(1,-1)">
                <text x={flatCamX - 0.4} y={-(params.deadband/2 + 0.2)} fill="#ef4444" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="auto">Deadband {params.deadband.toFixed(2)}mm</text>
              </g>

              {/* Height Arrow */}
              <line x1={maxCamX + 0.6} y1={-params.deadband/2} x2={maxCamX + 0.6} y2={-params.deadband/2 + params.height} stroke="#10b981" strokeWidth="0.03" />
              <line x1={maxCamX + 0.4} y1={-params.deadband/2} x2={maxCamX + 0.8} y2={-params.deadband/2} stroke="#10b981" strokeWidth="0.05" />
              <line x1={maxCamX + 0.4} y1={-params.deadband/2 + params.height} x2={maxCamX + 0.8} y2={-params.deadband/2 + params.height} stroke="#10b981" strokeWidth="0.05" />
              <g transform="scale(1,-1)">
                <text x={maxCamX + 0.8} y={-(-params.deadband/2 - 0.2)} fill="#10b981" fontSize="0.22" fontWeight="bold" textAnchor="end" dominantBaseline="hanging">Height {params.height.toFixed(2)}mm</text>
              </g>

              {/* Default distance Gap Trace */}
              <line x1={r} y1={minY + 0.5} x2={flatCamX} y2={minY + 0.5} stroke="#f59e0b" strokeWidth="0.03" />
              <line x1={r} y1={minY + 0.3} x2={r} y2={minY + 0.7} stroke="#f59e0b" strokeWidth="0.05" />
              <line x1={flatCamX} y1={minY + 0.3} x2={flatCamX} y2={minY + 0.7} stroke="#f59e0b" strokeWidth="0.05" />
              <g transform="scale(1,-1)">
                <text x={flatCamX + 0.3} y={-(minY + 0.5)} fill="#f59e0b" fontSize="0.22" fontWeight="bold" textAnchor="start" dominantBaseline="middle">Def. Dist {params.default_distance.toFixed(3)}mm</text>
              </g>
              
              {/* Absolute Geometric Gap measurement (Min distance between circle and curve) */}
              {(() => {
                // Find point on curve closest to center (0,0)
                let minDist = Infinity;
                let closestIdx = 0;
                data.cam_X.forEach((x, i) => {
                  const d = Math.sqrt(x*x + data.cam_Y[i]*data.cam_Y[i]);
                  if (d < minDist) {
                    minDist = d;
                    closestIdx = i;
                  }
                });
                
                const xCam = data.cam_X[closestIdx];
                const yCam = data.cam_Y[closestIdx];
                const dCenter = Math.sqrt(xCam*xCam + yCam*yCam);
                const nx = xCam / dCenter;
                const ny = yCam / dCenter;
                
                // Account for 0.25mm play between axis and bushing
                const actualGap = (dCenter - r) + 0.25;
                
                // Play offset center (Shifted AWAY from the cam contact by 0.25mm)
                const offX = -0.25 * nx;
                const offY = -0.25 * ny;
                
                // Coordinates on circle surface (radial projection from offset center)
                const xCirc = offX + nx * r;
                const yCirc = offY + ny * r;

                return (
                  <g>
                    {/* Dashed circle for Play/Clearance effect */}
                    <circle cx={offX} cy={offY} r={r} fill="none" stroke="#f59e0b" strokeWidth="0.02" strokeDasharray="0.1 0.1" />
                    
                    {/* Measurement Line (Starts from shifted circle) */}
                    <line x1={xCirc} y1={yCirc} x2={xCam} y2={yCam} stroke="#f59e0b" strokeWidth="0.04" strokeDasharray="0.05 0.05" />
                    
                    {/* Contact points */}
                    <circle cx={xCirc} cy={yCirc} r="0.03" fill="#f59e0b" />
                    <circle cx={xCam} cy={yCam} r="0.03" fill="#f59e0b" />

                    {/* Label (offset more to the right for clear visibility) */}
                    <g transform={`translate(${xCam + 0.8}, ${yCam}) scale(1,-1)`}>
                      <rect x="-0.4" y="-0.15" width="1.2" height="0.3" fill="#171717" fillOpacity="0.8" rx="0.05" />
                      <text x="0.2" y="0.05" fill="#f59e0b" fontSize="0.22" fontWeight="bold" textAnchor="middle">
                        Gap {actualGap.toFixed(3)}mm
                      </text>
                    </g>
                  </g>
                );
              })()}
            </g>
          )}

        </motion.svg>
      </div>
    </div>
  );
}

function ConfigModal({ 
  isOpen, onClose, configs, onHoverConfig, onSelectConfig, onDeleteConfig, onSetDefault, selectedConfig, defaultConfig, previewParams, previewData, onApply 
}: { 
  isOpen: boolean, 
  onClose: () => void, 
  configs: string[], 
  onHoverConfig: (name: string) => void,
  onSelectConfig: (name: string) => void,
  onDeleteConfig: (name: string, e: React.MouseEvent) => void,
  onSetDefault: (name: string) => void,
  selectedConfig: string | null,
  defaultConfig: string | null,
  previewParams: SimulationParams | null,
  previewData: SimulationResult | null,
  onApply: () => void
}) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md">
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-4xl h-[70vh] flex overflow-hidden"
      >
        {/* Left: List */}
        <div className="w-64 border-r border-neutral-800 flex flex-col bg-neutral-900/50">
          <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
            <h3 className="text-sm font-bold text-white uppercase tracking-tighter">Configurations</h3>
            <button onClick={onClose} className="text-neutral-500 hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {configs.map(name => (
              <div 
                key={name}
                className="group relative flex items-center"
              >
                <button
                  onMouseEnter={() => onHoverConfig(name)}
                  onClick={() => onSelectConfig(name)}
                  className={`flex-1 text-left px-3 py-2 rounded-lg text-xs transition-all pr-10 ${
                    selectedConfig === name 
                    ? 'bg-blue-600 text-white font-bold' 
                    : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
                  }`}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="truncate">{name}</span>
                    {defaultConfig === name && (
                      <div className="flex items-center gap-1 bg-emerald-500 text-white px-1.5 py-0.5 rounded text-[7px] font-black uppercase tracking-tighter shadow-sm shrink-0">
                         <div className="w-1 h-1 rounded-full bg-white animate-pulse" />
                         DEFAULT
                      </div>
                    )}
                  </div>
                </button>
                <button 
                  onClick={(e) => onDeleteConfig(name, e)}
                  className="absolute right-2 p-1.5 rounded-md text-neutral-600 hover:text-red-400 hover:bg-red-500/10 opacity-0 group-hover:opacity-100 transition-all"
                  title="Delete Config"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
          <div className="p-4 border-t border-neutral-800">
            <button 
              disabled={!selectedConfig}
              onClick={onApply}
              className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg text-sm font-bold transition-all shadow-lg"
            >
              OPEN CONFIG
            </button>
          </div>
        </div>

        {/* Right: Preview */}
        <div className="flex-1 bg-neutral-950 flex flex-col">
          <div className="p-4 border-b border-neutral-800 flex justify-between items-center bg-neutral-900/40">
             <h4 className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Configuration Preview</h4>
             {selectedConfig && (
               <button 
                 onClick={() => onSetDefault(selectedConfig)}
                 disabled={defaultConfig === selectedConfig}
                 className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all border ${
                   defaultConfig === selectedConfig 
                   ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 opacity-50' 
                   : 'bg-blue-600/10 border-blue-500/30 text-blue-400 hover:bg-blue-600/20'
                 }`}
               >
                 {defaultConfig === selectedConfig ? "IS DEFAULT" : "DEFINE AS DEFAULT"}
               </button>
             )}
          </div>
          <div className="flex-1 relative overflow-hidden flex items-center justify-center p-8">
            {previewParams ? (
              <div className="w-full h-full flex flex-col items-center justify-center">
                <VerticalSystemView 
                  data={previewData} 
                  params={previewParams!} 
                  details={true} 
                  setDetails={() => {}} 
                  isPreview={true}
                />
              </div>
            ) : (
              <div className="text-neutral-600 text-sm font-medium animate-pulse">
                Hover a config to preview...
              </div>
            )}
          </div>
          {previewParams && (
            <div className="p-4 bg-neutral-900 border-t border-neutral-800 grid grid-cols-3 gap-4">
               <div>
                  <div className="text-[10px] text-neutral-500 uppercase font-bold">Tube</div>
                  <div className="text-xs text-neutral-300">{previewParams.tube_id} x {previewParams.tube_od} mm</div>
               </div>
               <div>
                  <div className="text-[10px] text-neutral-500 uppercase font-bold">Compliance</div>
                  <div className="text-xs text-neutral-300">{previewParams.compliance} mm/MPa</div>
               </div>
               <div>
                  <div className="text-[10px] text-neutral-500 uppercase font-bold">Bushing</div>
                  <div className="text-xs text-neutral-300">{previewParams.bushing_diameter} mm</div>
               </div>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
