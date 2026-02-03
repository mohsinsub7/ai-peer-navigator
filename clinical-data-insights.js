// clinical-data-insights.js - Frontend logic for clinical data insights
import { chunkAndUploadFile } from '/client/file-chunker.js';

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4MB

// ==================== File Validation ====================
function validateFile(file) {
  if (!file) {
    throw new Error('No file selected');
  }
  
  const ext = file.name.toLowerCase();
  
  // Check file extension first
  if (!ext.endsWith('.csv')) {
    throw new Error('Invalid file type. Only CSV files are accepted. Please refer to the Upload Guide for help converting your file.');
  }
  
  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File too large (${(file.size / 1024 / 1024).toFixed(2)}MB). Maximum size is 4MB. Please refer to the Upload Guide for help reducing file size.`);
  }
  
  return true;
}

// ==================== File Analysis ====================
function profileDataset(rows) {
  if (!rows || rows.length === 0) return null;
  
  const columns = Object.keys(rows[0]).map(name => {
    const values = rows.map(r => r[name]).filter(v => v != null && v !== '');
    const sample = values.slice(0, 5);
    const isNumeric = values.every(v => !isNaN(Number(v)));
    const uniqueCount = new Set(values).size;
    
    return {
      name,
      type: isNumeric ? 'number' : 'string',
      uniqueValues: uniqueCount,
      sample,
      nullCount: rows.length - values.length
    };
  });
  
  return {
    title: 'Clinical Dataset',
    rowCount: rows.length,
    columnCount: columns.length,
    columns
  };
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    rows.push(row);
  }
  
  return rows;
}

async function parseFile(file) {
  const ext = file.name.toLowerCase();
  
  if (ext.endsWith('.csv') || ext.endsWith('.txt')) {
    const text = await file.text();
    return parseCSV(text);
  } else if (ext.endsWith('.xlsx') || ext.endsWith('.xls')) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(firstSheet);
  } else if (ext.endsWith('.pdf')) {
    // For PDFs, we'll send to backend for text extraction
    return null; // Will be handled by backend
  }
  
  throw new Error('Unsupported file format');
}

// ==================== Domain Detection ====================
function detectClinicalDomains(profile) {
  if (!profile || !profile.columns) return [];
  
  const domains = new Set();
  const columnNames = profile.columns.map(c => c.name.toLowerCase()).join(' ');
  
  // Behavioral Health & Mental Health
  if (/mental|psych|behavior|anxiety|depression|mood|therapy|counseling|session/i.test(columnNames)) {
    domains.add('Behavioral Health');
    domains.add('Mental Health');
  }
  
  // Substance Use Disorder
  if (/substance|sud|opioid|alcohol|drug|mat|moud|buprenorphine|methadone|naloxone|treatment|recovery|relapse|sobriety/i.test(columnNames)) {
    domains.add('Substance Use Disorder');
  }
  
  // SDOH
  if (/social|housing|food|transport|employment|income|education|z\-?code|barrier|sdoh/i.test(columnNames)) {
    domains.add('Social Determinants of Health');
  }
  
  // Quality Measures
  if (/hedis|quality|measure|star|performance|screening|immunization|preventive/i.test(columnNames)) {
    domains.add('Quality Measures');
  }
  
  // Clinical Billing / RCM
  if (/claim|billing|revenue|payment|denial|cpt|icd|procedure|diagnosis|authorization|copay|reimbursement/i.test(columnNames)) {
    domains.add('Clinical Billing & RCM');
  }
  
  // Utilization
  if (/admit|discharge|length.*stay|ed|emergency|readmission|utilization|visit/i.test(columnNames)) {
    domains.add('Utilization Management');
  }
  
  // Pharmacy
  if (/medication|prescription|pharmacy|drug|formulary|adherence/i.test(columnNames)) {
    domains.add('Pharmacy & Medication');
  }
  
  // Patient Safety
  if (/adverse|incident|error|safety|fall|infection/i.test(columnNames)) {
    domains.add('Patient Safety');
  }
  
  // Demographics
  if (/age|gender|race|ethnicity|demographic|population/i.test(columnNames)) {
    domains.add('Demographics & Population');
  }
  
  // Provider Performance
  if (/provider|physician|clinician|practitioner|productivity/i.test(columnNames)) {
    domains.add('Provider Performance');
  }
  
  return Array.from(domains);
}

// ==================== API Calls ====================
async function runClinicalInsights(file, profile) {
  console.log('[Clinical] Starting analysis', { name: file.name, size: file.size });
  
  // Upload file in chunks
  const { manifestKey, profileKey } = await chunkAndUploadFile(file, profile);
  console.log('[Clinical] Uploaded to blobs', { manifestKey, profileKey });

  // Wait for Blobs propagation
  console.log('[Clinical] Waiting for Blobs propagation (2.5s)...');
  await new Promise(r => setTimeout(r, 2500));

  // Detect domains
  const domains = detectClinicalDomains(profile);
  console.log('[Clinical] Detected domains:', domains);

  // Start background analysis with domain context
  const start = await fetch('/.netlify/functions/clinical-insights-processor', {
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ 
      manifestKey, 
      profileKey,
      domains,
      fileName: file.name
    })
  });
  
  if (!start.ok) {
    const errorText = await start.text();
    console.error('[Clinical] Start failed:', errorText);
    throw new Error(`Failed to start analysis (${start.status}): ${errorText.slice(0, 200)}`);
  }
  
  const { jobId } = await start.json();
  console.log('[Clinical] Job started', { jobId });

  // Update progress bar
  let progress = 10;
  const progressInterval = setInterval(() => {
    progress = Math.min(progress + 5, 90);
    updateProgress(progress);
  }, 1500);

  // Poll for results
  try {
    while (true) {
      await new Promise(r => setTimeout(r, 2000));
      const r = await fetch(`/.netlify/functions/analytics-result?jobId=${jobId}`);
      if (!r.ok) continue;
      const out = await r.json();
      if (out.status === 'complete') {
        clearInterval(progressInterval);
        updateProgress(100);
        return out.dashboard;
      }
      if (out.status === 'error') {
        clearInterval(progressInterval);
        throw new Error(out.error);
      }
    }
  } catch (error) {
    clearInterval(progressInterval);
    throw error;
  }
}

// ==================== UI Rendering ====================
function showSection(id) {
  document.getElementById(id).classList.remove('hidden');
}

function hideSection(id) {
  document.getElementById(id).classList.add('hidden');
}

function showToast(message, duration = 4000) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), duration);
}

function updateProgress(percent) {
  const fill = document.getElementById('progress-fill');
  if (fill) {
    fill.style.width = `${percent}%`;
  }
}

function renderFileInfo(file) {
  const info = document.getElementById('file-info');
  const sizeInMB = (file.size / 1024 / 1024).toFixed(2);
  info.innerHTML = `
    <strong>File:</strong> ${file.name} (${sizeInMB} MB) • 
    <strong>Type:</strong> ${file.type || 'Unknown'} • 
    <strong>Status:</strong> <span style="color:var(--accent)">Ready for analysis</span>
  `;
  info.classList.remove('hidden');
}

function renderProfile(profile) {
  const content = document.getElementById('profile-content');
  
  if (!profile) {
    content.innerHTML = '<span class="muted">No data uploaded yet.</span>';
    return;
  }
  
  const html = `
    <div style="margin-bottom: 12px;">
      <strong>${profile.rowCount.toLocaleString()}</strong> rows × 
      <strong>${profile.columnCount}</strong> columns
    </div>
    <div style="font-size: 12px; color: var(--muted); line-height:1.6">
      <strong>Columns:</strong> ${profile.columns.map(c => c.name).join(', ')}
    </div>
  `;
  
  content.innerHTML = html;
}

function renderDetectedDomains(domains) {
  if (!domains || domains.length === 0) return;
  
  const section = document.getElementById('detected-domains');
  const list = document.getElementById('domain-list');
  
  list.innerHTML = domains.map(d => `
    <div class="domain-tag">
      <span class="dot"></span>
      ${d}
    </div>
  `).join('');
  
  section.classList.remove('hidden');
}

function renderKPIs(kpis) {
  const grid = document.getElementById('kpi-grid');
  grid.innerHTML = '';
  
  kpis.forEach(kpi => {
    const div = document.createElement('div');
    div.className = 'kpi';
    
    let displayValue = kpi.value;
    
    if (kpi.format === 'currency') {
      // Remove any existing $ signs and parse as number
      const numValue = typeof displayValue === 'string' 
        ? parseFloat(displayValue.replace(/[$,]/g, ''))
        : displayValue;
      displayValue = '$' + numValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } else if (kpi.format === 'percent') {
      // Handle both decimal (0.04) and whole number (4) percentages
      let numValue = typeof displayValue === 'string' 
        ? parseFloat(displayValue.replace(/%/g, ''))
        : displayValue;
      
      // If value is less than 1, assume it's a decimal that needs to be converted to percentage
      if (numValue < 1 && numValue > 0) {
        numValue = numValue * 100;
      }
      
      displayValue = numValue.toFixed(2) + '%';
    } else if (typeof kpi.value === 'number') {
      displayValue = kpi.value.toLocaleString();
    }
    
    div.innerHTML = `
      <div class="label">${kpi.label}</div>
      <div class="value">${displayValue}</div>
      ${kpi.trend ? `<div class="trend">${kpi.trend}</div>` : ''}
    `;
    
    grid.appendChild(div);
  });
  
  showSection('kpi-section');
}

function renderCharts(charts) {
  const grid = document.getElementById('chart-grid');
  grid.innerHTML = '';
  
  // Initialize chart instances array
  if (!window.__chartInstances) {
    window.__chartInstances = [];
  }
  window.__chartInstances = [];
  
  if (!charts || charts.length === 0) {
    grid.innerHTML = '<p class="muted" style="text-align:center; padding:40px">No charts available for this dataset.</p>';
    return;
  }
  
  charts.forEach((chart, idx) => {
    // Validate chart has necessary data
    if (!chart.config || (!chart.config.data && !chart.config.series)) {
      console.warn(`Chart ${idx} missing data, skipping`, chart);
      return;
    }
    
    const container = document.createElement('div');
    container.className = 'chart';
    container.id = `chart-${idx}`;
    grid.appendChild(container);
    
    const chartInstance = echarts.init(container);
    window.__chartInstances.push(chartInstance);
    
    let option;
    
    if (chart.type === 'line' || chart.type === 'area') {
      option = {
        title: { 
          text: chart.title || 'Chart', 
          textStyle: { color: '#e5e7eb', fontSize: 16, fontWeight: 'bold' },
          left: 'center',
          top: 10
        },
        tooltip: { 
          trigger: 'axis',
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          borderColor: '#38bdf8',
          textStyle: { color: '#e5e7eb' }
        },
        grid: { left: 80, right: 50, top: 70, bottom: 80 },
        xAxis: {
          type: 'category',
          name: chart.config.xAxisLabel || '',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { color: '#94a3b8', fontSize: 13, fontWeight: 'bold' },
          data: chart.config.labels || [],
          axisLabel: { 
            color: '#94a3b8', 
            rotate: chart.config.labels?.length > 10 ? 35 : 0,
            fontSize: 11,
            interval: 'auto',
            overflow: 'truncate',
            width: 80,
            formatter: function(value) {
              return value.length > 15 ? value.substring(0, 15) + '...' : value;
            }
          },
          axisLine: { lineStyle: { color: '#334155' } }
        },
        yAxis: {
          type: 'value',
          name: chart.config.yAxisLabel || '',
          nameLocation: 'middle',
          nameGap: 60,
          nameTextStyle: { color: '#94a3b8', fontSize: 13, fontWeight: 'bold' },
          axisLabel: { 
            color: '#94a3b8', 
            fontSize: 11,
            formatter: function(value) {
              // Format large numbers
              if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
              if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
              return value;
            }
          },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { lineStyle: { color: '#1e293b' } }
        },
        series: chart.config.series ? chart.config.series.map(s => ({
          name: s.name,
          type: chart.type === 'area' ? 'line' : 'line',
          data: s.data,
          smooth: true,
          areaStyle: chart.type === 'area' ? { opacity: 0.3 } : undefined,
          lineStyle: { width: 3 },
          itemStyle: { borderWidth: 2 }
        })) : [{
          type: chart.type === 'area' ? 'line' : 'line',
          data: chart.config.data || [],
          smooth: true,
          areaStyle: chart.type === 'area' ? { opacity: 0.3 } : undefined,
          itemStyle: { color: '#38bdf8' },
          lineStyle: { width: 3, color: '#38bdf8' }
        }]
      };
    } else if (chart.type === 'bar') {
      option = {
        title: { 
          text: chart.title || 'Chart', 
          textStyle: { color: '#e5e7eb', fontSize: 16, fontWeight: 'bold' },
          left: 'center',
          top: 10
        },
        tooltip: { 
          trigger: 'axis',
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          borderColor: '#38bdf8',
          textStyle: { color: '#e5e7eb' }
        },
        grid: { left: 80, right: 50, top: 70, bottom: 80 },
        xAxis: {
          type: 'category',
          name: chart.config.xAxisLabel || '',
          nameLocation: 'middle',
          nameGap: 45,
          nameTextStyle: { color: '#94a3b8', fontSize: 13, fontWeight: 'bold' },
          data: chart.config.labels || [],
          axisLabel: { 
            color: '#94a3b8', 
            rotate: chart.config.labels?.length > 10 ? 35 : 0,
            fontSize: 11,
            interval: 'auto',
            overflow: 'truncate',
            width: 80,
            formatter: function(value) {
              return value.length > 15 ? value.substring(0, 15) + '...' : value;
            }
          },
          axisLine: { lineStyle: { color: '#334155' } }
        },
        yAxis: {
          type: 'value',
          name: chart.config.yAxisLabel || '',
          nameLocation: 'middle',
          nameGap: 60,
          nameTextStyle: { color: '#94a3b8', fontSize: 13, fontWeight: 'bold' },
          axisLabel: { 
            color: '#94a3b8', 
            fontSize: 11,
            formatter: function(value) {
              // Format large numbers
              if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
              if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
              return value;
            }
          },
          axisLine: { lineStyle: { color: '#334155' } },
          splitLine: { lineStyle: { color: '#1e293b' } }
        },
        series: chart.config.series ? chart.config.series.map(s => ({
          name: s.name,
          type: 'bar',
          data: s.data,
          itemStyle: {
            borderRadius: [4, 4, 0, 0]
          }
        })) : [{
          type: 'bar',
          data: chart.config.data || [],
          itemStyle: { 
            color: '#38bdf8',
            borderRadius: [4, 4, 0, 0]
          }
        }]
      };
    } else if (chart.type === 'pie') {
      const data = chart.config.labels ? chart.config.labels.map((label, i) => ({
        name: label,
        value: chart.config.data[i]
      })) : chart.config.data || [];
      
      option = {
        title: { 
          text: chart.title || 'Chart', 
          textStyle: { color: '#e5e7eb', fontSize: 16, fontWeight: 'bold' },
          left: 'center',
          top: 10
        },
        tooltip: {
          trigger: 'item',
          backgroundColor: 'rgba(15, 23, 42, 0.9)',
          borderColor: '#38bdf8',
          textStyle: { color: '#e5e7eb' },
          formatter: '{b}: {c} ({d}%)'
        },
        legend: {
          orient: 'horizontal',
          bottom: 5,
          textStyle: { color: '#94a3b8', fontSize: 10 },
          formatter: function(name) {
            return name.length > 20 ? name.substring(0, 20) + '...' : name;
          }
        },
        series: [{
          type: 'pie',
          radius: ['40%', '70%'],
          center: ['50%', '50%'],
          data,
          label: { 
            color: '#e5e7eb', 
            fontSize: 10,
            formatter: function(params) {
              const name = params.name.length > 15 ? params.name.substring(0, 15) + '...' : params.name;
              return `${name}\n${params.percent.toFixed(1)}%`;
            }
          },
          labelLine: {
            lineStyle: { color: '#475569' }
          },
          emphasis: {
            itemStyle: {
              shadowBlur: 10,
              shadowOffsetX: 0,
              shadowColor: 'rgba(0, 0, 0, 0.5)'
            }
          }
        }]
      };
    }
    
    if (option) {
      chartInstance.setOption(option);
    } else {
      console.warn(`Unsupported chart type: ${chart.type}`);
    }
  });
  
  // Show charts section
  showSection('charts-section');
  
  // After section is visible, force a resize so ECharts computes layout
  setTimeout(() => window.__chartInstances.forEach(c => c.resize()), 0);
  window.addEventListener('resize', () => window.__chartInstances.forEach(c => c.resize()));
}

function renderInsights(insights) {
  const list = document.getElementById('insights-list');
  list.innerHTML = '';
  
  insights.forEach(insight => {
    const li = document.createElement('li');
    li.textContent = insight;
    list.appendChild(li);
  });
  
  showSection('insights-section');
}

function renderDashboard(dashboard) {
  hideSection('loading-section');
  
  if (dashboard.title) {
    document.getElementById('dash-title').textContent = dashboard.title;
  }
  
  if (dashboard.kpis && dashboard.kpis.length > 0) {
    renderKPIs(dashboard.kpis);
  }
  
  if (dashboard.charts && dashboard.charts.length > 0) {
    renderCharts(dashboard.charts);
  }
  
  if (dashboard.insights && dashboard.insights.length > 0) {
    renderInsights(dashboard.insights);
  }
  
  // Store dashboard for export
  window.__clinicalDashboard = dashboard;
}

// ==================== PDF Export ====================
async function exportToPDF() {
  try {
    showToast('Generating PDF report...', 2000);
    
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const margin = 15;
    let yPos = margin;
    
    // Title
    pdf.setFontSize(18);
    pdf.setFont(undefined, 'bold');
    pdf.setTextColor(15, 23, 42);
    pdf.text('Clinical Data Insights Report', pageWidth / 2, yPos, { align: 'center' });
    yPos += 8;
    
    // Date
    pdf.setFontSize(10);
    pdf.setFont(undefined, 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Generated: ${new Date().toLocaleString()}`, pageWidth / 2, yPos, { align: 'center' });
    yPos += 15;
    
    const dashboard = window.__clinicalDashboard;
    if (!dashboard) {
      pdf.text('No dashboard data available', margin, yPos);
      pdf.save('clinical-insights-report.pdf');
      return;
    }
    
    // KPIs Section
    if (dashboard.kpis && dashboard.kpis.length > 0) {
      pdf.setFontSize(14);
      pdf.setFont(undefined, 'bold');
      pdf.setTextColor(15, 23, 42);
      pdf.text('Key Performance Indicators', margin, yPos);
      yPos += 8;
      
      pdf.setFontSize(9);
      pdf.setFont(undefined, 'normal');
      dashboard.kpis.forEach(kpi => {
        if (yPos > pageHeight - 30) {
          pdf.addPage();
          yPos = margin;
        }
        pdf.setTextColor(100, 116, 139);
        pdf.text(`${kpi.label}:`, margin + 5, yPos);
        pdf.setTextColor(15, 23, 42);
        let value = kpi.value;
        if (kpi.format === 'currency') value = '$' + value.toLocaleString();
        else if (kpi.format === 'percent') value = value + '%';
        else if (typeof value === 'number') value = value.toLocaleString();
        pdf.text(String(value), margin + 90, yPos);
        yPos += 5;
      });
      yPos += 8;
    }
    
    // Charts Section - Capture each chart as image
    if (window.__chartInstances && window.__chartInstances.length > 0) {
      pdf.addPage();
      yPos = margin;
      
      pdf.setFontSize(14);
      pdf.setFont(undefined, 'bold');
      pdf.setTextColor(15, 23, 42);
      pdf.text('Visual Analytics', margin, yPos);
      yPos += 10;
      
      for (let i = 0; i < window.__chartInstances.length; i++) {
        const chart = window.__chartInstances[i];
        
        // Get chart as image using ECharts built-in method
        const chartImage = chart.getDataURL({
          type: 'png',
          pixelRatio: 2,
          backgroundColor: '#0b162a'
        });
        
        // Calculate dimensions (fit 2 charts per page)
        const chartWidth = pageWidth - (2 * margin);
        const chartHeight = 70;
        
        // Check if we need a new page
        if (yPos + chartHeight > pageHeight - margin) {
          pdf.addPage();
          yPos = margin;
        }
        
        // Add chart image to PDF
        pdf.addImage(chartImage, 'PNG', margin, yPos, chartWidth, chartHeight);
        yPos += chartHeight + 10;
      }
    }
    
    // Insights Section
    if (dashboard.insights && dashboard.insights.length > 0) {
      pdf.addPage();
      yPos = margin;
      
      pdf.setFontSize(14);
      pdf.setFont(undefined, 'bold');
      pdf.setTextColor(15, 23, 42);
      pdf.text('AI-Generated Insights', margin, yPos);
      yPos += 10;
      
      pdf.setFontSize(9);
      pdf.setFont(undefined, 'normal');
      pdf.setTextColor(51, 65, 85);
      dashboard.insights.forEach((insight, idx) => {
        if (yPos > pageHeight - 25) {
          pdf.addPage();
          yPos = margin;
        }
        const lines = pdf.splitTextToSize(`${idx + 1}. ${insight}`, pageWidth - (2 * margin));
        pdf.text(lines, margin, yPos);
        yPos += (lines.length * 4) + 4;
      });
    }
    
    // Footer on all pages
    const totalPages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      pdf.setFontSize(8);
      pdf.setFont(undefined, 'normal');
      pdf.setTextColor(148, 163, 184);
      pdf.text(`Page ${i} of ${totalPages}`, pageWidth / 2, pageHeight - 10, { align: 'center' });
      pdf.text('COGENCY Clinical Data Insights', pageWidth / 2, pageHeight - 5, { align: 'center' });
    }
    
    pdf.save(`clinical-insights-${new Date().toISOString().slice(0, 10)}.pdf`);
    showToast('✓ PDF report downloaded successfully');
    
  } catch (error) {
    console.error('[PDF Export] Error:', error);
    showToast('✗ Failed to generate PDF: ' + error.message, 5000);
  }
}

// ==================== Main Processing ====================
async function processFile(file) {
  try {
    // Validate file
    validateFile(file);
    
    // Show file info
    renderFileInfo(file);
    
    // Hide old results
    hideSection('kpi-section');
    hideSection('charts-section');
    hideSection('insights-section');
    hideSection('detected-domains');
    
    // Parse file (if possible client-side)
    console.log('[Clinical] Parsing file...');
    let dataset = null;
    let profile = null;
    
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.pdf')) {
      dataset = await parseFile(file);
      
      if (!dataset || dataset.length === 0) {
        throw new Error('No data found in file');
      }
      
      console.log('[Clinical] Parsed dataset', { rows: dataset.length });
      
      // Profile data
      profile = profileDataset(dataset);
      renderProfile(profile);
      
      // Detect and show domains
      const domains = detectClinicalDomains(profile);
      renderDetectedDomains(domains);
    } else {
      // For PDFs, create a minimal profile
      profile = {
        title: 'PDF Clinical Document',
        fileName: file.name,
        fileSize: file.size,
        isPDF: true
      };
      renderProfile(profile);
    }
    
    // Show loading
    showSection('loading-section');
    updateProgress(10);
    
    // Run AI analysis
    const dashboard = await runClinicalInsights(file, profile);
    
    // Render results
    renderDashboard(dashboard);
    
    showToast('✓ Clinical insights generated successfully');
    
  } catch (error) {
    console.error('[Clinical] Error:', error);
    hideSection('loading-section');
    showToast('✗ ' + error.message, 6000);
  }
}

// ==================== Sample Data ====================
async function loadSampleData() {
  const sampleCSV = `PatientID,Age,Gender,Diagnosis,SessionsAttended,NoShows,TreatmentType,OutcomeScore,InsuranceType,HousingStatus,EmploymentStatus
P001,34,F,Major Depressive Disorder,12,2,CBT,85,Medicaid,Stable,Employed
P002,28,M,Opioid Use Disorder,8,5,MAT,65,Uninsured,Homeless,Unemployed
P003,45,F,Generalized Anxiety Disorder,15,1,Medication Management,92,Commercial,Stable,Employed
P004,52,M,Alcohol Use Disorder,6,4,Group Therapy,58,Medicare,At Risk,Unemployed
P005,31,F,PTSD,10,3,EMDR,78,Medicaid,Stable,Part-time
P006,39,M,Bipolar Disorder,14,2,Medication + Therapy,88,Commercial,Stable,Employed
P007,26,F,Substance Use Disorder,4,7,Residential Treatment,45,Uninsured,Homeless,Unemployed
P008,48,M,Depression,11,1,CBT,82,Medicare,Stable,Retired
P009,33,F,Anxiety,13,2,Mindfulness-Based Therapy,86,Commercial,Stable,Employed
P010,41,M,Opioid Use Disorder,9,3,Buprenorphine MAT,72,Medicaid,Transitional,Part-time
P011,29,F,Eating Disorder,7,4,DBT,68,Commercial,Stable,Employed
P012,55,M,Alcohol Use Disorder,5,6,Detox + Counseling,52,Medicare,At Risk,Unemployed
P013,37,F,Major Depressive Disorder,16,0,Medication Management,94,Commercial,Stable,Employed
P014,44,M,Cocaine Use Disorder,3,8,Outpatient Counseling,38,Uninsured,Homeless,Unemployed
P015,30,F,Generalized Anxiety Disorder,14,1,CBT,90,Medicaid,Stable,Employed`;

  const blob = new Blob([sampleCSV], { type: 'text/csv' });
  const file = new File([blob], 'clinical-sample-data.csv', { type: 'text/csv' });
  
  await processFile(file);
}

// ==================== Event Handlers ====================
function setupEventListeners() {
  // File input
  const fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      processFile(file);
    }
  });
  
  // Drag & drop
  const dropzone = document.getElementById('dropzone');
  
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    
    const file = e.dataTransfer.files[0];
    if (file) {
      processFile(file);
    }
  });
  
  // Sample button
  const sampleBtn = document.getElementById('btn-sample');
  sampleBtn.addEventListener('click', () => {
    loadSampleData();
  });
  
  // PDF Export
  const exportBtn = document.getElementById('export-pdf-btn');
  exportBtn.addEventListener('click', () => {
    exportToPDF();
  });
}

// ==================== Initialize ====================
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  console.log('[Clinical] App initialized');
});
