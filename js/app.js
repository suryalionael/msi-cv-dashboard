/**
 * MSI CV Engine — main application
 *
 * State flow:
 *   init() → loadEmployees() → sidebar dropdown populated
 *   loadEmployee(name) → API call → render editor panels
 *   user edits → state mutations + debounced localStorage save
 *   Save Draft → API.saveCVData(buildPayload())
 *   Generate CV → API.generateCV(buildPayload()) → result modal
 */

const App = (() => {

  // ── State ────────────────────────────────────────────────────────────────────

  const state = {
    employees: [],
    current: null,       // loaded employee name
    data: null,          // raw cvModel from backend
    basicInfo: { summary: '', role: '', yearsExperience: '' },
    projects: [],        // [{...cvModel project, selected, responsibility, tools}]
    skillGroups: [],     // [{category, expanded, items:[{skill, selected}]}]
    training: [],        // [{name, provider, year, selected, isManual}]
    loading: false,
    generating: false,
    draftDirty: false,
    autoSaveTimer: null,
    currentTab: 'overview',
  };

  // ── Selectors (cached after DOMContentLoaded) ─────────────────────────────

  let $ = {};

  function cacheSelectors() {
    $ = {
      employeeSelect:   document.getElementById('employee-select'),
      loadBtn:          document.getElementById('load-btn'),
      employeeBadge:    document.getElementById('employee-badge'),
      employeePicker:   document.getElementById('employee-picker'),
      navSection:       document.getElementById('nav-section'),
      changeEmpFooter:  document.getElementById('change-emp-footer'),
      welcome:          document.getElementById('welcome-screen'),
      editor:           document.getElementById('editor'),
      actionBar:        document.getElementById('action-bar'),
      loadingOverlay:   document.getElementById('loading-overlay'),
      loadingMessage:   document.getElementById('loading-message'),
      configBanner:     document.getElementById('config-banner'),
      sectionTitle:     document.getElementById('section-title'),
      sectionSubtitle:  document.getElementById('section-subtitle'),
      sectionBadge:     document.getElementById('section-badge'),
      // Basic info
      fieldSummary:     document.getElementById('field-summary'),
      fieldRole:        document.getElementById('field-role'),
      fieldYears:       document.getElementById('field-years'),
      fieldTargetRole:  document.getElementById('field-target-role'),
      fieldJobDesc:     document.getElementById('field-job-desc'),
      aiSummaryBtn:     document.getElementById('ai-summary-btn'),
      // Panel badges (sidebar nav)
      badgeProjects:    document.getElementById('badge-projects'),
      badgeSkills:      document.getElementById('badge-skills'),
      badgeTraining:    document.getElementById('badge-training'),
      // Content areas
      projectsTbody:    document.getElementById('projects-tbody'),
      projectSearch:    document.getElementById('project-search'),
      skillsContainer:  document.getElementById('skills-container'),
      trainingList:     document.getElementById('training-list'),
      addTrainingBtn:   document.getElementById('add-training-btn'),
      // Actions
      saveDraftBtn:     document.getElementById('save-draft-btn'),
      generateBtn:      document.getElementById('generate-btn'),
      draftStatus:      document.getElementById('draft-status'),
      // Modal
      resultModal:      document.getElementById('result-modal'),
      modalIcon:        document.getElementById('modal-icon'),
      modalTitle:       document.getElementById('modal-title'),
      modalMessage:     document.getElementById('modal-message'),
      modalLinks:       document.getElementById('modal-links'),
      modalClose:       document.getElementById('modal-close'),
      // AI Results
      aiResults:        document.getElementById('ai-results'),
      scoreCircle:      document.getElementById('score-circle'),
      scoreValue:       document.getElementById('score-value'),
      scoreRole:        document.getElementById('score-role'),
      strengthsContainer: document.getElementById('strengths-container'),
      improvementsContainer: document.getElementById('improvements-container'),
      experiencesRankingBody: document.getElementById('experiences-ranking-body'),
      projectsRankingBody: document.getElementById('projects-ranking-body'),
      skillsRankingBody: document.getElementById('skills-ranking-body'),
      missingSkillsCard: document.getElementById('missing-skills-card'),
      missingSkillsList: document.getElementById('missing-skills-list'),
      atsKeywordsCard: document.getElementById('ats-keywords-card'),
      atsKeywordsList: document.getElementById('ats-keywords-list'),
      rankingsCard:     document.getElementById('rankings-card'),
    };
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    cacheSelectors();
    bindEvents();
    checkConfig();
    await loadEmployees();
  }

  function checkConfig() {
    if (!CONFIG.GAS_URL || CONFIG.GAS_URL.startsWith('YOUR_')) {
      $.configBanner.classList.remove('hidden');
    }
  }

  // ── Load employees ────────────────────────────────────────────────────────────

  async function loadEmployees() {
    if (!CONFIG.GAS_URL || CONFIG.GAS_URL.startsWith('YOUR_')) return;
    showLoading('Connecting to CV Engine…');
    try {
      const result = await API.getEmployees();
      state.employees = result.employees || [];
      renderEmployeeDropdown();
    } catch (err) {
      showToast('Could not load employee list: ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  }

  function renderEmployeeDropdown() {
    const sel = $.employeeSelect;
    sel.innerHTML = '<option value="">— Select Employee —</option>';
    state.employees.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  }

  // ── Load employee data ────────────────────────────────────────────────────────

  async function loadEmployee(name) {
    if (!name) return;
    showLoading('Loading data for ' + name + '…');
    try {
      const data = await API.getEmployeeData(name);
      state.current = name;
      state.data = data;

      state.basicInfo = {
        summary: data.summary || '',
        role: data.position || '',
        yearsExperience: data.yearsExperience != null ? String(data.yearsExperience) : '',
        targetRole: '',
        jobDescription: '',
      };

      state.projects = (data.projects || []).map((p) => ({
        name: p.name || '',
        client: p.client || '',
        period: p.period || '',
        role: p.role || '',
        responsibility: p.responsibility || '',
        tools: p.tools || '',
        selected: true,
      }));

      state.skillGroups = (data.technicalSkills || []).map((g) => ({
        category: g.category || '',
        expanded: true,
        items: (g.values || []).map((skill) => ({ skill, selected: true })),
      }));

      state.training = (data.training || []).map((t) => ({
        name: t.name || '',
        provider: t.provider || '',
        year: String(t.year || ''),
        selected: true,
        isManual: false,
      }));

      tryRestoreDraft(name);
      renderEditor();
      showEditor();
    } catch (err) {
      showToast('Could not load ' + name + ': ' + err.message, 'error');
    } finally {
      hideLoading();
    }
  }

  // ── Render editor ─────────────────────────────────────────────────────────────

  function renderEditor() {
    $.fieldSummary.value = state.basicInfo.summary;
    $.fieldRole.value    = state.basicInfo.role;
    $.fieldYears.value   = state.basicInfo.yearsExperience;
    $.fieldTargetRole.value = state.basicInfo.targetRole || '';
    $.fieldJobDesc.value    = state.basicInfo.jobDescription || '';

    clearAiResults();

    // Employee card in sidebar
    const initials = state.current
      .split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    $.employeeBadge.innerHTML = `
      <p class="working-on-label">Working on</p>
      <div class="emp-row">
        <div class="emp-avatar">${initials}</div>
        <div>
          <p class="emp-name">${esc(state.current)}</p>
          <p class="emp-role">${esc(state.basicInfo.role || 'Employee')}</p>
        </div>
      </div>`;
    $.employeeBadge.classList.remove('hidden');

    renderProjectsTable();
    renderSkillsPanel();
    renderTrainingList();
    updateAllBadges();
  }

  // ── Projects ──────────────────────────────────────────────────────────────────

  function renderProjectsTable(filter = '') {
    const container = $.projectsTbody;
    container.innerHTML = '';
    const lc = filter.toLowerCase();
    let anyVisible = false;

    state.projects.forEach((p, idx) => {
      if (lc && !p.name.toLowerCase().includes(lc) && !p.client.toLowerCase().includes(lc)) return;
      anyVisible = true;

      const card = document.createElement('div');
      card.className = 'project-card' + (p.selected ? ' selected' : '');
      card.dataset.idx = idx;
      card.innerHTML = `
        <input type="checkbox" class="project-check" data-idx="${idx}" ${p.selected ? 'checked' : ''} style="display:none">
        <div class="project-card-header">
          <p class="project-card-name">${esc(p.name)}</p>
          <div class="project-checkbox-box" style="background:${p.selected ? '#2060A0' : 'transparent'};border-color:${p.selected ? '#2060A0' : 'var(--border-med)'}">
            ${p.selected ? '<i class="ti ti-check" aria-hidden="true" style="font-size:10px;color:#fff"></i>' : ''}
          </div>
        </div>
        <span class="client-tag">${esc(p.client)}</span>
        <p class="project-meta"><i class="ti ti-calendar-event" aria-hidden="true"></i> ${esc(p.period)}</p>
        <p class="project-meta"><i class="ti ti-user" aria-hidden="true"></i> ${esc(p.role)}</p>
        <div class="project-responsibility-wrap" style="${p.selected ? '' : 'display:none'}">
          <p class="resp-label">Responsibility</p>
          <input type="text" class="cell-input responsibility-input" data-idx="${idx}"
            value="${esc(p.responsibility)}" placeholder="Describe main responsibilities…"
            onclick="event.stopPropagation()">
          <input type="text" class="cell-input tools-input" data-idx="${idx}"
            value="${esc(p.tools)}" placeholder="Tools used (e.g. SAP, Jira, Power BI)"
            onclick="event.stopPropagation()">
        </div>`;
      container.appendChild(card);
    });

    if (!anyVisible) {
      container.innerHTML = '<p class="empty-msg" style="grid-column:1/-1">No projects found.</p>';
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────────

  function renderSkillsPanel() {
    const container = $.skillsContainer;
    container.innerHTML = '';

    state.skillGroups.forEach((group, gIdx) => {
      const section = document.createElement('div');
      section.className = 'skill-group';

      const header = document.createElement('div');
      header.className = 'skill-group-header';
      header.innerHTML = `
        <p class="skill-group-name">${esc(group.category)}</p>
        <div class="skill-group-actions">
          <button class="skill-sel-btn skill-sel-all skill-all" data-gidx="${gIdx}">Select all</button>
          <button class="skill-sel-btn skill-sel-none skill-none" data-gidx="${gIdx}">Clear</button>
        </div>`;

      const body = document.createElement('div');
      body.className = 'skill-group-body';

      group.items.forEach((item, iIdx) => {
        const label = document.createElement('label');
        label.className = 'skill-chip' + (item.selected ? '' : ' unchecked');
        label.innerHTML = `
          <input type="checkbox" class="skill-check"
            data-gidx="${gIdx}" data-iidx="${iIdx}" ${item.selected ? 'checked' : ''}>
          ${esc(item.skill)}`;
        body.appendChild(label);
      });

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    });

    if (!state.skillGroups.length) {
      container.innerHTML = '<p class="empty-msg">No technical skills data found.</p>';
    }
  }

  // ── Training ──────────────────────────────────────────────────────────────────

  function renderTrainingList() {
    const list = $.trainingList;
    list.innerHTML = '';

    state.training.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'training-card training-row';
      row.innerHTML = `
        <input type="checkbox" class="training-check" data-idx="${idx}" checked>
        <div class="training-icon-box">
          <i class="ti ti-certificate" aria-hidden="true"></i>
        </div>
        <div class="training-info">
          <input type="text" class="training-name" data-idx="${idx}"
            value="${esc(t.name)}" placeholder="Training / certification name">
          <div class="training-meta-row">
            <input type="text" class="training-provider" data-idx="${idx}"
              value="${esc(t.provider)}" placeholder="Provider">
            <input type="text" class="training-year" data-idx="${idx}"
              value="${esc(t.year)}" placeholder="Year" maxlength="4">
          </div>
        </div>
        <button class="training-remove-btn remove-training" data-idx="${idx}" aria-label="Remove">
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>`;
      list.appendChild(row);
    });

    if (!state.training.length) {
      list.innerHTML = '<p class="empty-msg">No training data found. Add entries below.</p>';
    }
  }

  // ── Counters ──────────────────────────────────────────────────────────────────

  function updateAllBadges() {
    const projCount  = state.projects.filter((p) => p.selected).length;
    const skillCount = state.skillGroups.reduce(
      (acc, g) => acc + g.items.filter((i) => i.selected).length, 0
    );
    const trainCount = state.training.filter((t) => t.selected && t.name.trim()).length;

    if ($.badgeProjects) $.badgeProjects.textContent = projCount;
    if ($.badgeSkills)   $.badgeSkills.textContent   = skillCount;
    if ($.badgeTraining) $.badgeTraining.textContent = trainCount;

    // Section badge in top bar
    const badgeText = {
      projects: projCount + ' / ' + state.projects.length + ' selected',
      skills:   skillCount + ' selected',
      training: trainCount + ' selected',
    }[state.currentTab];

    if ($.sectionBadge) {
      if (badgeText) {
        $.sectionBadge.textContent = badgeText;
        $.sectionBadge.classList.remove('hidden');
      } else {
        $.sectionBadge.classList.add('hidden');
      }
    }
  }

  // ── Tab switching ─────────────────────────────────────────────────────────────

  function switchTab(tab) {
    state.currentTab = tab;

    document.querySelectorAll('.nav-item[data-tab]').forEach((btn) => btn.classList.remove('active'));
    const activeNav = document.querySelector(`.nav-item[data-tab="${tab}"]`);
    if (activeNav) activeNav.classList.add('active');

    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    const pane = document.getElementById('tab-' + tab);
    if (pane) pane.classList.add('active');

    const headers = {
      overview: ['Overview',               'Basic info, role and professional summary'],
      projects: ['Projects',               'Select and edit projects to include in the CV'],
      skills:   ['Technical skills',       'Select skills by category'],
      training: ['Training & certifications', 'Manage training and certification records'],
    };
    const [title, subtitle] = headers[tab] || ['', ''];
    if ($.sectionTitle)    $.sectionTitle.textContent    = title;
    if ($.sectionSubtitle) $.sectionSubtitle.textContent = subtitle;

    updateAllBadges();
  }

  // ── Change employee ───────────────────────────────────────────────────────────

  function changeEmployee() {
    state.current     = null;
    state.data        = null;
    state.currentTab  = 'overview';

    $.editor.classList.add('hidden');
    $.actionBar.classList.add('hidden');
    $.welcome.classList.remove('hidden');
    $.employeeBadge.classList.add('hidden');
    $.navSection.classList.add('hidden');
    $.changeEmpFooter.classList.add('hidden');
    $.employeePicker.classList.remove('hidden');

    if ($.sectionTitle)    $.sectionTitle.textContent    = 'Select an employee';
    if ($.sectionSubtitle) $.sectionSubtitle.textContent = 'Choose from the sidebar to begin';
    if ($.sectionBadge)    $.sectionBadge.classList.add('hidden');
  }

  // ── Build payload ─────────────────────────────────────────────────────────────

  function buildPayload() {
    const summary        = $.fieldSummary.value.trim();
    const role           = $.fieldRole.value.trim();
    const yearsExp       = $.fieldYears.value.trim();
    const targetRole     = $.fieldTargetRole.value.trim();
    const jobDescription = $.fieldJobDesc.value.trim();

    // Read from project cards (data-idx on each card)
    const projects = [];
    $.projectsTbody.querySelectorAll('[data-idx]').forEach((card) => {
      const idx = parseInt(card.dataset.idx, 10);
      const chk = card.querySelector('.project-check');
      if (!chk || !chk.checked) return;
      const p = state.projects[idx];
      const responsibility = card.querySelector('.responsibility-input')?.value.trim() || p.responsibility;
      const tools          = card.querySelector('.tools-input')?.value.trim()          || p.tools;
      projects.push({ name: p.name, client: p.client, period: p.period, role: p.role, responsibility, tools });
    });

    const skills = [];
    state.skillGroups.forEach((g) => {
      g.items.forEach((item) => {
        if (item.selected) skills.push({ category: g.category, skill: item.skill });
      });
    });

    const trainingRows = [];
    $.trainingList.querySelectorAll('.training-row').forEach((row) => {
      const chk = row.querySelector('.training-check');
      if (!chk || !chk.checked) return;
      const name     = row.querySelector('.training-name')?.value.trim()     || '';
      const provider = row.querySelector('.training-provider')?.value.trim() || '';
      const year     = row.querySelector('.training-year')?.value.trim()     || '';
      if (name) trainingRows.push({ name, provider, year });
    });

    return { employeeName: state.current, summary, role, yearsExperience: yearsExp, targetRole, jobDescription, projects, skills, training: trainingRows };
  }

  // ── Save draft ────────────────────────────────────────────────────────────────

  async function saveDraft(silent = false) {
    if (!state.current) return;
    const payload = buildPayload();
    saveLocalDraft(state.current, payload);

    if (!silent) {
      $.saveDraftBtn.disabled = true;
      $.saveDraftBtn.textContent = 'Saving…';
      try {
        await API.saveCVData(payload);
        showDraftStatus('Draft saved ✓');
      } catch (err) {
        showDraftStatus('Local draft saved (server error: ' + err.message + ')');
      } finally {
        $.saveDraftBtn.disabled = false;
        $.saveDraftBtn.textContent = 'Save Draft';
      }
    }
  }

  // ── Generate CV ───────────────────────────────────────────────────────────────

  async function generateCV() {
    if (!state.current) return;
    if (state.generating) return;
    state.generating = true;

    const payload = buildPayload();
    if (!payload.projects.length && !payload.skills.length) {
      showToast('Select at least one project or skill before generating.', 'warn');
      state.generating = false;
      return;
    }

    showLoading('Generating CV for ' + state.current + '…\nThis may take up to 30 seconds.');
    $.generateBtn.disabled = true;

    try {
      const result = await API.generateCV(payload, (_, msg) => showLoading(msg));
      hideLoading();
      showResultModal(true, state.current, result);
    } catch (err) {
      hideLoading();
      showResultModal(false, state.current, { error: err.message });
    } finally {
      state.generating = false;
      $.generateBtn.disabled = false;
    }
  }

  // ── AI Resume Optimizer ────────────────────────────────────────────────────────

  var _optimizingTimer = null;

  function showOptimizingMessage(steps) {
    var i = 0;
    showLoading(steps[i] || 'Analyzing Resume…');
    clearInterval(_optimizingTimer);
    _optimizingTimer = setInterval(function () {
      i++;
      if (i < steps.length) {
        showLoading(steps[i]);
      } else {
        clearInterval(_optimizingTimer);
        _optimizingTimer = null;
      }
    }, 2500);
  }

  function clearOptimizingMessage() {
    clearInterval(_optimizingTimer);
    _optimizingTimer = null;
  }

  function clearAiResults() {
    $.aiResults.classList.add('hidden');
    $.scoreCircle.className = 'score-circle';
    $.scoreValue.textContent = '0';
    $.scoreRole.textContent = '';
    $.strengthsContainer.innerHTML = '';
    $.improvementsContainer.innerHTML = '';
    $.experiencesRankingBody.innerHTML = '';
    $.projectsRankingBody.innerHTML = '';
    $.skillsRankingBody.innerHTML = '';
    $.missingSkillsCard.classList.add('hidden');
    $.missingSkillsList.innerHTML = '';
    $.atsKeywordsCard.classList.add('hidden');
    $.atsKeywordsList.innerHTML = '';
  }

  async function generateAiSummary() {
    if (!state.current) return;

    const payload = buildPayload();
    if (!payload.targetRole) {
      showToast('Please enter an Expected Role before optimizing.', 'warn');
      $.fieldTargetRole.focus();
      return;
    }

    if (!payload.projects.length && !payload.skills.length) {
      showToast('Select at least one project or skill before optimizing.', 'warn');
      return;
    }

    const btn = $.aiSummaryBtn;
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="ai-spinner"></span> Optimizing…';

    showOptimizingMessage([
      'Analyzing Resume…',
      'Scoring Experiences…',
      'Scoring Projects…',
      'Optimizing Projects…',
      'Generating Summary…',
    ]);

    try {
      const result = await API.optimizeResume({
        employeeName: payload.employeeName,
        expectedRole: payload.targetRole,
        jobDescription: payload.jobDescription,
      });

      if (!result || !result.success) {
        throw new Error((result && result.error) || 'AI optimization failed');
      }

      var opt = result;

      // Apply project refinements: select top projects, update responsibilities
      if (opt.projects && opt.projects.length) {
        var topProjectNames = new Set(opt.projects.map(function (p) { return p.name; }));
        state.projects.forEach(function (p) {
          p.selected = topProjectNames.has(p.name);
          var match = opt.projects.find(function (op) { return op.name === p.name; });
          if (match && match.refinedResponsibility) {
            p.responsibility = match.refinedResponsibility;
          }
        });
        renderProjectsTable($.projectSearch.value);
      }

      // Apply skill refinements: select top skills
      if (opt.skills && opt.skills.length) {
        var topSkillsMap = {};
        opt.skills.forEach(function (s) {
          var key = (s.category || '') + '|' + (s.skill || '');
          topSkillsMap[key] = true;
        });
        state.skillGroups.forEach(function (g) {
          g.items.forEach(function (item) {
            item.selected = !!topSkillsMap[g.category + '|' + item.skill];
          });
        });
        renderSkillsPanel();
      }

      // Update professional summary
      if (opt.professionalSummary) {
        $.fieldSummary.value = opt.professionalSummary;
        $.fieldSummary.dispatchEvent(new Event('input', { bubbles: true }));
      }

      updateAllBadges();

      // Render AI results sections
      renderAiResults(opt);

      showToast('Resume optimized successfully. ' + (opt.projects ? opt.projects.length : 0) + ' projects, ' + (opt.skills ? opt.skills.length : 0) + ' skills selected.', 'info');

      // Scroll to results
      $.aiResults.scrollIntoView({ behavior: 'smooth', block: 'start' });

    } catch (err) {
      showToast('AI optimization failed: ' + err.message, 'error');
    } finally {
      clearOptimizingMessage();
      hideLoading();
      btn.disabled = false;
      btn.innerHTML = originalHTML;
    }
  }

  function renderAiResults(opt) {
    renderScoreCard(opt);
    renderExplanation(opt);
    renderRankings(opt);
    renderMissingSkills(opt);
    renderAtsKeywords(opt);
    $.aiResults.classList.remove('hidden');
  }

  function renderScoreCard(opt) {
    var score = opt.resumeMatchScore || 0;
    $.scoreValue.textContent = score;
    $.scoreRole.textContent = state.basicInfo.targetRole || '';

    var circle = $.scoreCircle;
    circle.className = 'score-circle';
    if (score >= 90) circle.classList.add('score-high');
    else if (score >= 75) circle.classList.add('score-medium');
    else circle.classList.add('score-low');

    circle.style.setProperty('--score-pct', score + '%');
  }

  function renderExplanation(opt) {
    var strengths = opt.strengths || [];
    var improvements = opt.improvements || [];

    if (strengths.length) {
      $.strengthsContainer.innerHTML =
        '<div class="explanation-group"><div class="explanation-title">Strengths</div>' +
        strengths.map(function (s) { return '<div class="explanation-item explanation-strength"><i class="ti ti-circle-check"></i> ' + esc(s) + '</div>'; }).join('') +
        '</div>';
    } else {
      $.strengthsContainer.innerHTML = '';
    }

    if (improvements.length) {
      $.improvementsContainer.innerHTML =
        '<div class="explanation-group"><div class="explanation-title">Areas to Improve</div>' +
        improvements.map(function (s) { return '<div class="explanation-item explanation-improve"><i class="ti ti-alert-triangle"></i> ' + esc(s) + '</div>'; }).join('') +
        '</div>';
    } else {
      $.improvementsContainer.innerHTML = '';
    }
  }

  function renderRankings(opt) {
    // Experiences
    if (opt.experiences && opt.experiences.length) {
      $.experiencesRankingBody.innerHTML = opt.experiences.map(function (e) {
        return rankingRow(e.position + (e.company ? ' at ' + e.company : ''), e.score, e.confidence);
      }).join('');
    } else {
      $.experiencesRankingBody.innerHTML = '<p class="empty-msg" style="padding:8px">No experiences scored.</p>';
    }

    // Projects
    if (opt.projects && opt.projects.length) {
      $.projectsRankingBody.innerHTML = opt.projects.map(function (p) {
        return rankingRow(p.name, p.score, p.confidence);
      }).join('');
    } else {
      $.projectsRankingBody.innerHTML = '<p class="empty-msg" style="padding:8px">No projects scored.</p>';
    }

    // Skills
    if (opt.skills && opt.skills.length) {
      $.skillsRankingBody.innerHTML = opt.skills.map(function (s) {
        return rankingRow(s.skill + (s.category ? ' (' + s.category + ')' : ''), s.score, s.confidence);
      }).join('');
    } else {
      $.skillsRankingBody.innerHTML = '<p class="empty-msg" style="padding:8px">No skills scored.</p>';
    }
  }

  function rankingRow(label, score, confidence) {
    var confClass = 'conf-' + (confidence || 'medium');
    return '<div class="ranking-row">' +
      '<span class="ranking-label">' + esc(label) + '</span>' +
      '<span class="ranking-score">' + score + '</span>' +
      '<span class="ranking-confidence ' + confClass + '">' + esc(confidence || 'medium') + '</span>' +
      '</div>';
  }

  function renderMissingSkills(opt) {
    var skills = opt.missingSkills || [];
    if (skills.length) {
      $.missingSkillsList.innerHTML = skills.map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('');
      $.missingSkillsCard.classList.remove('hidden');
    } else {
      $.missingSkillsCard.classList.add('hidden');
    }
  }

  function renderAtsKeywords(opt) {
    var keywords = opt.atsKeywords || [];
    if (keywords.length && $.fieldJobDesc.value.trim()) {
      $.atsKeywordsList.innerHTML = keywords.map(function (k) { return '<span class="chip">' + esc(k) + '</span>'; }).join('');
      $.atsKeywordsCard.classList.remove('hidden');
    } else {
      $.atsKeywordsCard.classList.add('hidden');
    }
  }

  // ── Event binding ─────────────────────────────────────────────────────────────

  function bindEvents() {
    // Load employee
    $.loadBtn.addEventListener('click', () => {
      const name = $.employeeSelect.value;
      if (name) loadEmployee(name);
      else showToast('Please select an employee first.', 'warn');
    });

    $.employeeSelect.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $.loadBtn.click();
    });

    // Basic info
    [$.fieldSummary, $.fieldRole, $.fieldYears, $.fieldTargetRole, $.fieldJobDesc].forEach((el) => {
      el.addEventListener('input', () => markDirty());
    });

    $.aiSummaryBtn?.addEventListener('click', () => generateAiSummary());

    // Ranking section toggle (event delegation)
    $.rankingsCard?.addEventListener('click', function (e) {
      var header = e.target.closest('.ranking-header');
      if (header) {
        header.classList.toggle('collapsed');
        var body = header.nextElementSibling;
        if (body) body.classList.toggle('hidden');
      }
    });

    // Project card click — toggle selection without full re-render
    $.projectsTbody.addEventListener('click', (e) => {
      if (e.target.classList.contains('responsibility-input') ||
          e.target.classList.contains('tools-input')) return;

      const card = e.target.closest('.project-card');
      if (!card) return;

      const idx = parseInt(card.dataset.idx, 10);
      state.projects[idx].selected = !state.projects[idx].selected;

      const chk = card.querySelector('.project-check');
      if (chk) chk.checked = state.projects[idx].selected;

      card.classList.toggle('selected', state.projects[idx].selected);

      const cbBox = card.querySelector('.project-checkbox-box');
      if (cbBox) {
        if (state.projects[idx].selected) {
          cbBox.style.background   = '#2060A0';
          cbBox.style.borderColor  = '#2060A0';
          cbBox.innerHTML = '<i class="ti ti-check" aria-hidden="true" style="font-size:10px;color:#fff"></i>';
        } else {
          cbBox.style.background   = 'transparent';
          cbBox.style.borderColor  = 'var(--border-med)';
          cbBox.innerHTML = '';
        }
      }

      const respWrap = card.querySelector('.project-responsibility-wrap');
      if (respWrap) respWrap.style.display = state.projects[idx].selected ? '' : 'none';

      updateAllBadges();
      markDirty();
    });

    // Project responsibility / tools edits
    $.projectsTbody.addEventListener('input', (e) => {
      if (e.target.classList.contains('responsibility-input')) {
        state.projects[parseInt(e.target.dataset.idx, 10)].responsibility = e.target.value;
        markDirty();
      } else if (e.target.classList.contains('tools-input')) {
        state.projects[parseInt(e.target.dataset.idx, 10)].tools = e.target.value;
        markDirty();
      }
    });

    // Project search
    $.projectSearch.addEventListener('input', (e) => {
      renderProjectsTable(e.target.value);
    });

    // Skills (delegated)
    $.skillsContainer.addEventListener('change', (e) => {
      if (e.target.classList.contains('skill-check')) {
        const gIdx = parseInt(e.target.dataset.gidx, 10);
        const iIdx = parseInt(e.target.dataset.iidx, 10);
        state.skillGroups[gIdx].items[iIdx].selected = e.target.checked;
        const label = e.target.closest('label');
        if (label) label.classList.toggle('unchecked', !e.target.checked);
        updateAllBadges();
        markDirty();
      }
    });

    $.skillsContainer.addEventListener('click', (e) => {
      if (e.target.classList.contains('skill-all')) {
        setGroupSelection(parseInt(e.target.dataset.gidx, 10), true);
        return;
      }
      if (e.target.classList.contains('skill-none')) {
        setGroupSelection(parseInt(e.target.dataset.gidx, 10), false);
      }
    });

    // Training (delegated)
    $.trainingList.addEventListener('input', (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      if (e.target.classList.contains('training-name')) {
        if (!isNaN(idx)) state.training[idx].name = e.target.value;
        markDirty();
        updateAllBadges();
      } else if (e.target.classList.contains('training-provider')) {
        if (!isNaN(idx)) state.training[idx].provider = e.target.value;
        markDirty();
      } else if (e.target.classList.contains('training-year')) {
        if (!isNaN(idx)) state.training[idx].year = e.target.value;
        markDirty();
      }
    });

    $.trainingList.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.remove-training');
      if (removeBtn) {
        const idx = parseInt(removeBtn.dataset.idx, 10);
        state.training.splice(idx, 1);
        renderTrainingList();
        updateAllBadges();
        markDirty();
      }
    });

    // Add training
    $.addTrainingBtn.addEventListener('click', () => {
      state.training.push({ name: '', provider: '', year: '', selected: true, isManual: true });
      renderTrainingList();
      updateAllBadges();
      const rows = $.trainingList.querySelectorAll('.training-row');
      if (rows.length) rows[rows.length - 1].querySelector('.training-name')?.focus();
    });

    // Save draft
    $.saveDraftBtn.addEventListener('click', () => saveDraft(false));

    // Generate CV
    $.generateBtn.addEventListener('click', () => generateCV());

    // Modal close
    $.modalClose.addEventListener('click', () => $.resultModal.classList.add('hidden'));
    $.resultModal.addEventListener('click', (e) => {
      if (e.target === $.resultModal) $.resultModal.classList.add('hidden');
    });
  }

  // ── Skill group helpers ───────────────────────────────────────────────────────

  function setGroupSelection(gIdx, selected) {
    state.skillGroups[gIdx].items.forEach((item) => { item.selected = selected; });
    renderSkillsPanel();
    updateAllBadges();
    markDirty();
  }

  // ── UI helpers ────────────────────────────────────────────────────────────────

  function showEditor() {
    $.welcome.classList.add('hidden');
    $.editor.classList.remove('hidden');
    $.actionBar.classList.remove('hidden');
    $.employeePicker.classList.add('hidden');
    $.navSection.classList.remove('hidden');
    $.changeEmpFooter.classList.remove('hidden');
    switchTab('overview');
  }

  function showLoading(message = 'Loading…') {
    $.loadingMessage.textContent = message;
    $.loadingOverlay.classList.remove('hidden');
  }

  function hideLoading() {
    $.loadingOverlay.classList.add('hidden');
  }

  function showToast(message, type = 'info') {
    let toast = document.getElementById('toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = 'toast toast-' + type;
    toast.classList.remove('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.add('hidden'), 4000);
  }

  function showDraftStatus(msg) {
    if (!$.draftStatus) return;
    $.draftStatus.textContent = msg;
    clearTimeout($.draftStatus._timer);
    $.draftStatus._timer = setTimeout(() => { $.draftStatus.textContent = ''; }, 5000);
  }

  function showResultModal(success, employeeName, result) {
    $.modalIcon.textContent = success ? '✓' : '✕';
    $.modalIcon.className   = 'modal-icon ' + (success ? 'success' : 'error');
    $.modalTitle.textContent = success ? 'CV Generated!' : 'Generation Failed';
    $.modalMessage.textContent = success
      ? `CV for ${employeeName} is ready.`
      : `Could not generate CV: ${result.error || 'Unknown error.'}`;

    $.modalLinks.innerHTML = '';
    if (success) {
      [
        { label: 'Open Google Doc', url: result.docUrl  },
        { label: 'Download PDF',   url: result.pdfUrl  },
        { label: 'Download .docx', url: result.docxUrl },
      ].forEach(({ label, url }) => {
        if (!url) return;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'modal-link';
        a.textContent = label;
        $.modalLinks.appendChild(a);
      });
    }

    $.resultModal.classList.remove('hidden');
  }

  // ── Draft persistence (localStorage) ─────────────────────────────────────────

  function markDirty() {
    state.draftDirty = true;
    if (CONFIG.AUTO_SAVE_INTERVAL_MS > 0) {
      clearTimeout(state.autoSaveTimer);
      state.autoSaveTimer = setTimeout(() => {
        if (state.draftDirty && state.current) {
          saveDraft(true);
          state.draftDirty = false;
        }
      }, CONFIG.AUTO_SAVE_INTERVAL_MS);
    }
  }

  function saveLocalDraft(name, payload) {
    try {
      localStorage.setItem(CONFIG.DRAFT_KEY_PREFIX + name, JSON.stringify({
        savedAt: new Date().toISOString(),
        payload,
      }));
    } catch (_) {}
  }

  function tryRestoreDraft(name) {
    try {
      const raw = localStorage.getItem(CONFIG.DRAFT_KEY_PREFIX + name);
      if (!raw) return;
      const { savedAt, payload } = JSON.parse(raw);
      const d = new Date(savedAt);
      const ago = Math.round((Date.now() - d.getTime()) / 60000);
      const label = ago < 1 ? 'just now' : ago + ' min ago';
      const restore = confirm(`A local draft for ${name} was saved ${label}.\n\nRestore it?`);
      if (!restore) return;

      if (payload.summary != null)         state.basicInfo.summary         = payload.summary;
      if (payload.role != null)            state.basicInfo.role            = payload.role;
      if (payload.yearsExperience != null) state.basicInfo.yearsExperience = payload.yearsExperience;
      if (payload.targetRole != null)      state.basicInfo.targetRole      = payload.targetRole;
      if (payload.jobDescription != null)  state.basicInfo.jobDescription  = payload.jobDescription;

      if (Array.isArray(payload.projects)) {
        const sel = new Set(payload.projects.map((p) => p.name));
        state.projects.forEach((p) => {
          p.selected = sel.has(p.name);
          const saved = payload.projects.find((sp) => sp.name === p.name);
          if (saved) {
            if (saved.responsibility != null) p.responsibility = saved.responsibility;
            if (saved.tools != null)          p.tools          = saved.tools;
          }
        });
      }

      if (Array.isArray(payload.skills)) {
        const sel = new Set(payload.skills.map((s) => s.category + '|' + s.skill));
        state.skillGroups.forEach((g) => {
          g.items.forEach((item) => {
            item.selected = sel.has(g.category + '|' + item.skill);
          });
        });
      }

      if (Array.isArray(payload.training)) {
        const trainingSel = new Set(payload.training.map((t) => t.name.toLowerCase()));
        state.training.forEach((t) => { t.selected = trainingSel.has(t.name.toLowerCase()); });
        payload.training.forEach((dt) => {
          const exists = state.training.some((t) => t.name.toLowerCase() === dt.name.toLowerCase());
          if (!exists) state.training.push({ ...dt, selected: true, isManual: true });
        });
      }
    } catch (_) {}
  }

  // ── Utilities ─────────────────────────────────────────────────────────────────

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  return { init, switchTab, changeEmployee };

})();

document.addEventListener('DOMContentLoaded', () => App.init());
