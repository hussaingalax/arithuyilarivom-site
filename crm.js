(() => {
  'use strict';

  const config = window.MEDITATION_CONFIG;
  if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY || !window.supabase?.createClient) {
    document.addEventListener('DOMContentLoaded', () => {
      const m = document.getElementById('loginMessage');
      if (m) { m.textContent = 'CRM configuration could not be loaded. Check config.js and the Supabase JS library.'; m.classList.add('error'); }
    });
    return;
  }

  const sb = window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
  const $ = id => document.getElementById(id);
  const state = { user: null, profile: null, leads: [], allocations: [], users: [], reviews: [] };
  const ADMIN = 'admin';
  const SOURCES = {
    instagram_ad:'Instagram Ad', facebook_ad:'Facebook Ad', meta_ad:'Meta Ad',
    referral:'Referral', youtube:'YouTube', google_ads:'Google Ads', others:'Others'
  };
  const STAGES = {
    new_lead:'New lead', contacted:'Contacted', free_class_pending:'Free class pending',
    free_class_attended:'Free class attended', eight_week_interested:'8-week interested',
    follow_up:'Follow-up', lower_payment_class:'Lower-payment class',
    free_group_nurture:'Free group nurture', final_sale_closed:'Final sale closed',
    lost:'Lost', accidental_lead:'Accidental lead'
  };
  const CALL_STATUSES = {
    assigned:'Not called yet', call_completed:'Call completed',
    follow_up_required:'Follow-up required', transferred:'Transferred', not_called:'Not called'
  };
  const REVIEW_STATUSES = {
    excused:'Excused', rescheduled:'Rescheduled', valid_followup:'Valid follow-up',
    unexplained_pending:'Unexplained pending', other:'Other'
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // India-first phone normalization for click-to-call and WhatsApp links.
  function phoneDigits(value) {
    let digits = String(value ?? '').replace(/\\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
  }

  function leadContactActions(lead) {
    const digits = phoneDigits(lead?.mobile);
    if (!digits || digits.length < 10) return '';
    const message = `Vanakkam ${lead.full_name || ''}, Arithuyil Arivom team-lirundhu contact panrom. Ungal enquiry pathi pesalama?`;
    return `<div class="inline-actions contact-actions">
      <a class="button button-quiet" href="tel:+${esc(digits)}" aria-label="Call ${esc(lead.full_name || 'lead')}">Call</a>
      <a class="button button-quiet" href="https://wa.me/${esc(digits)}?text=${encodeURIComponent(message)}" target="_blank" rel="noopener noreferrer" aria-label="WhatsApp ${esc(lead.full_name || 'lead')}">WhatsApp</a>
    </div>`;
  }
  function setMessage(id, text, kind='') {
    const el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.className = `message ${kind}`.trim();
  }
  function showNotice(text) {
    $('notice').textContent = text;
    $('notice').classList.remove('hidden');
  }
  function clearNotice() { $('notice').classList.add('hidden'); $('notice').textContent = ''; }
  function isAdmin() { return state.profile?.role === ADMIN; }
  function isoToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? esc(value) : d.toLocaleString();
  }
  function localDateTimeToIso(value) {
    if (!value) return null;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  function roleUi() {
    document.querySelectorAll('.admin-only').forEach(el => el.classList.toggle('hidden', !isAdmin()));
    $('userBadge').textContent = `${state.profile.display_name} · ${state.profile.role}`;
    $('userBadge').classList.remove('hidden');
    $('logoutBtn').classList.remove('hidden');
    $('welcomeTitle').textContent = isAdmin() ? 'Admin Dashboard' : 'Sales Dashboard';
  }

  async function checkSession() {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    if (!data.session) return showLogin();
    await authorizeUser(data.session.user);
  }

  function showLogin(message='') {
    $('loginPanel').classList.remove('hidden');
    $('appPanel').classList.add('hidden');
    $('userBadge').classList.add('hidden');
    $('logoutBtn').classList.add('hidden');
    if (message) setMessage('loginMessage', message, 'error');
  }

  async function authorizeUser(user) {
    const { data: profile, error } = await sb.from('crm_users')
      .select('id,display_name,role,is_active')
      .eq('id', user.id)
      .maybeSingle();
    if (error) throw error;
    if (!profile || !profile.is_active || !['admin','salesperson'].includes(profile.role)) {
      await sb.auth.signOut();
      showLogin('This account does not have active CRM access. Ask the CRM admin to provision your account.');
      return;
    }
    state.user = user;
    state.profile = profile;
    $('loginPanel').classList.add('hidden');
    $('appPanel').classList.remove('hidden');
    $('workDate').value = isoToday();
    $('allocationDate').value = isoToday();
    roleUi();
    bindTabs();
    await refreshAll();
  }

  async function login(event) {
    event.preventDefault();
    const btn = $('loginForm').querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    setMessage('loginMessage','');
    try {
      const { data, error } = await sb.auth.signInWithPassword({
        email: $('loginEmail').value.trim(),
        password: $('loginPassword').value
      });
      if (error) throw error;
      await authorizeUser(data.user);
    } catch (err) {
      setMessage('loginMessage', err.message || 'Sign in failed.', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  async function logout() {
    await sb.auth.signOut();
    state.user = null; state.profile = null;
    showLogin('You have signed out.');
  }

  function bindTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
        document.querySelectorAll('.view').forEach(v => v.classList.toggle('hidden', v.id !== btn.dataset.tab));
        if (btn.dataset.tab === 'callsView') loadAllocations();
        if (btn.dataset.tab === 'reviewView') loadReviews();
      };
    });
  }

  async function refreshAll() {
    clearNotice();
    try {
      await Promise.all([loadLeads(), loadAllocations(), loadUsers()]);
      await loadReviews();
      renderStats();
    } catch (err) {
      showNotice(`Unable to load CRM data: ${err.message || err}`);
    }
  }

  async function loadLeads() {
    let query = sb.from('crm_leads')
      .select('id,full_name,mobile,source,source_detail,interested_program,pipeline_stage,tags,group_preference,common_group_status,class_preference,free_class_date,free_class_status,course_interest,objection_reason,next_followup_at,assigned_to,created_by,initial_owner_id,created_at,updated_at')
      .order('created_at', { ascending: false }).limit(500);
    if (!isAdmin()) query = query.eq('assigned_to', state.user.id);
    const { data, error } = await query;
    if (error) throw error;
    state.leads = data || [];
    renderLeads();
    fillLeadSelect();
  }

  async function loadUsers() {
    if (!isAdmin()) {
      state.users = [state.profile];
      return;
    }
    const { data, error } = await sb.from('crm_users')
      .select('id,display_name,role,is_active')
      .eq('is_active', true).order('display_name');
    if (error) throw error;
    state.users = data || [];
    fillSalespersonSelect();
  }

  async function loadAllocations() {
    const date = $('workDate').value || isoToday();
    let query = sb.from('crm_daily_allocations')
      .select('id,work_date,lead_id,salesperson_id,allocated_by,call_status,call_outcome,salesperson_note,completed_at,created_at')
      .eq('work_date', date).order('created_at', { ascending: true }).limit(1000);
    if (!isAdmin()) query = query.eq('salesperson_id', state.user.id);
    const { data, error } = await query;
    if (error) throw error;
    state.allocations = data || [];
    renderAllocations();
    renderStats();
  }

  async function loadReviews() {
    if (!isAdmin()) return;
    // Reviews are admin-readable only. Allocation list is used to determine rows needing review.
    const { data, error } = await sb.from('crm_allocation_reviews')
      .select('id,allocation_id,review_status,reason,reviewed_by,reviewed_at');
    if (error) throw error;
    state.reviews = data || [];
    renderReviews();
    renderStats();
  }

  function renderStats() {
    $('statLeads').textContent = state.leads.length;
    $('statAllocated').textContent = state.allocations.length;
    $('statCompleted').textContent = state.allocations.filter(a => a.call_status === 'call_completed').length;
    const reviewedIds = new Set(state.reviews.map(r => r.allocation_id));
    $('statReasonPending').textContent = isAdmin()
      ? state.allocations.filter(a => ['assigned','not_called'].includes(a.call_status) && !reviewedIds.has(a.id)).length
      : '—';
  }

  function renderLeads() {
    const search = $('leadSearch').value.trim().toLowerCase();
    const stage = $('stageFilter').value;
    const rows = state.leads.filter(l => {
      const matchSearch = !search || `${l.full_name} ${l.mobile} ${l.source_detail || ''}`.toLowerCase().includes(search);
      return matchSearch && (!stage || l.pipeline_stage === stage);
    });
    $('leadsBody').innerHTML = rows.length ? rows.map(l => `
      <tr>
        <td><div class="lead-title">${esc(l.full_name)}</div><div class="cell-sub">${esc(l.mobile)}</div>${leadContactActions(l)}<div class="cell-sub">${esc(l.interested_program || '')}</div></td>
        <td>${esc(SOURCES[l.source] || l.source)}<div class="cell-sub">${esc(l.source_detail || '')}</div></td>
        <td><span class="stage">${esc(STAGES[l.pipeline_stage] || l.pipeline_stage)}</span></td>
        <td>${esc(formatDate(l.next_followup_at))}</td>
        <td>${(l.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '—'}</td>
        <td><div class="inline-actions"><button class="button button-quiet" type="button" data-edit-lead="${esc(l.id)}">Edit</button>${isAdmin() ? `<button class="button button-quiet" type="button" data-allocate-lead="${esc(l.id)}">Allocate</button>` : ''}</div></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">No leads found for this filter.</td></tr>';
    document.querySelectorAll('[data-edit-lead]').forEach(b => b.onclick = () => editLead(b.dataset.editLead));
    document.querySelectorAll('[data-allocate-lead]').forEach(b => b.onclick = () => {
      $('allocationLead').value = b.dataset.allocateLead;
      document.querySelector('[data-tab="callsView"]').click();
      $('allocationSalesperson').focus();
    });
  }

  function fillLeadSelect() {
    const select = $('allocationLead');
    if (!select) return;
    const old = select.value;
    select.innerHTML = '<option value="">Choose a lead</option>' + state.leads.map(l =>
      `<option value="${esc(l.id)}">${esc(l.full_name)} · ${esc(l.mobile)}</option>`).join('');
    if (state.leads.some(l => l.id === old)) select.value = old;
  }
  function fillSalespersonSelect() {
    const select = $('allocationSalesperson');
    if (!select) return;
    select.innerHTML = '<option value="">Choose salesperson</option>' + state.users
      .filter(u => u.role === 'salesperson' && u.is_active)
      .map(u => `<option value="${esc(u.id)}">${esc(u.display_name)}</option>`).join('');
  }

  function renderAllocations() {
    $('allocationsBody').innerHTML = state.allocations.length ? state.allocations.map(a => {
      const lead = state.leads.find(l => l.id === a.lead_id);
      const person = state.users.find(u => u.id === a.salesperson_id);
      const statusOptions = Object.entries(CALL_STATUSES).map(([k,v]) => `<option value="${k}" ${a.call_status===k?'selected':''}>${esc(v)}</option>`).join('');
      const otherSalespeople = state.users.filter(u => u.role === 'salesperson' && u.is_active && u.id !== a.salesperson_id);
      const transferOptions = otherSalespeople.map(u => `<option value="${esc(u.id)}">${esc(u.display_name)}</option>`).join('');
      return `<tr>
        <td><div class="lead-title">${esc(lead?.full_name || 'Lead unavailable')}</div><div class="cell-sub">${esc(lead?.mobile || '')}</div>${lead ? leadContactActions(lead) : ''}</td>
        <td>${esc(person?.display_name || (a.salesperson_id === state.user.id ? state.profile.display_name : 'Salesperson'))}</td>
        <td>${isAdmin() ? `<span class="stage">${esc(CALL_STATUSES[a.call_status] || a.call_status)}</span>` : `<select class="small-select" data-call-status="${esc(a.id)}">${statusOptions}</select>`}</td>
        <td>${isAdmin() ? `${esc(a.call_outcome || '')}<div class="cell-sub">${esc(a.salesperson_note || '')}</div>` : `<input class="small-input" data-call-outcome="${esc(a.id)}" value="${esc(a.call_outcome || '')}" placeholder="Outcome"><input class="small-input" data-call-note="${esc(a.id)}" value="${esc(a.salesperson_note || '')}" placeholder="Note">`}</td>
        <td>${isAdmin()
          ? `<div class="inline-actions">${(a.call_status === 'assigned' || a.call_status === 'not_called') ? `<button class="button button-quiet" type="button" data-review-allocation="${esc(a.id)}">Review</button>` : ''}</div>
             <div class="transfer-controls"><select class="small-select" data-transfer-salesperson="${esc(a.id)}" aria-label="Transfer ${esc(lead?.full_name || 'lead')} to salesperson" ${otherSalespeople.length ? '' : 'disabled'}><option value="">${otherSalespeople.length ? 'Transfer to…' : 'No other salesperson'}</option>${transferOptions}</select>
             <button class="button button-quiet" type="button" data-transfer-allocation="${esc(a.id)}" ${otherSalespeople.length ? '' : 'disabled'}>Transfer</button></div>`
          : `<button class="button button-primary" type="button" data-save-allocation="${esc(a.id)}">Save status</button>`}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">No calls allocated for this date.</td></tr>';
    document.querySelectorAll('[data-save-allocation]').forEach(b => b.onclick = () => saveAllocation(b.dataset.saveAllocation));
    document.querySelectorAll('[data-review-allocation]').forEach(b => b.onclick = () => {
      document.querySelector('[data-tab="reviewView"]').click();
      const select = document.querySelector(`[data-review-status="${CSS.escape(b.dataset.reviewAllocation)}"]`);
      if (select) select.focus();
    });
    document.querySelectorAll('[data-transfer-allocation]').forEach(b =>
      b.onclick = () => transferAllocation(b.dataset.transferAllocation)
    );
  }

  function renderReviews() {
    if (!isAdmin()) return;
    const reviewByAllocation = new Map(state.reviews.map(r => [r.allocation_id, r]));
    const needsReview = state.allocations.filter(a => ['assigned','not_called'].includes(a.call_status));
    $('reviewsBody').innerHTML = needsReview.length ? needsReview.map(a => {
      const lead = state.leads.find(l => l.id === a.lead_id);
      const person = state.users.find(u => u.id === a.salesperson_id);
      const review = reviewByAllocation.get(a.id);
      return `<tr>
        <td>${esc(person?.display_name || 'Salesperson')}</td>
        <td><div class="lead-title">${esc(lead?.full_name || 'Lead unavailable')}</div><div class="cell-sub">${esc(lead?.mobile || '')}</div></td>
        <td><span class="stage">${esc(CALL_STATUSES[a.call_status] || a.call_status)}</span></td>
        <td><select class="small-select" data-review-status="${esc(a.id)}">${Object.entries(REVIEW_STATUSES).map(([k,v]) => `<option value="${k}" ${review?.review_status===k?'selected':''}>${esc(v)}</option>`).join('')}</select></td>
        <td><input class="small-input" data-review-reason="${esc(a.id)}" value="${esc(review?.reason || '')}" placeholder="Required reason"></td>
        <td><button class="button button-primary" type="button" data-save-review="${esc(a.id)}">Save review</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="6" class="empty">No uncompleted calls currently need review for this date.</td></tr>';
    document.querySelectorAll('[data-save-review]').forEach(b => b.onclick = () => saveReview(b.dataset.saveReview));
  }

  function resetLeadForm() {
    $('leadForm').reset();
    $('leadId').value = '';
    $('leadStage').value = 'new_lead';
    $('leadForm').classList.add('hidden');
    setMessage('leadFormMessage','');
  }
  function editLead(id) {
    const l = state.leads.find(x => x.id === id);
    if (!l) return;
    $('leadForm').classList.remove('hidden');
    $('leadId').value = l.id;
    $('leadName').value = l.full_name || '';
    $('leadMobile').value = l.mobile || '';
    $('leadSource').value = l.source || 'others';
    $('leadSourceDetail').value = l.source_detail || '';
    $('leadProgram').value = l.interested_program || '';
    $('leadStage').value = l.pipeline_stage || 'new_lead';
    $('leadClassPreference').value = l.class_preference || 'undecided';
    $('leadGroupPreference').value = l.group_preference || 'undecided';
    $('leadGroupStatus').value = l.common_group_status || 'not_discussed';
    $('leadFreeClassDate').value = l.free_class_date || '';
    $('leadFreeClassStatus').value = l.free_class_status || 'not_scheduled';
    $('leadInterest').value = l.course_interest || 'undecided';
    $('leadNextFollowup').value = l.next_followup_at ? new Date(l.next_followup_at).toISOString().slice(0,16) : '';
    $('leadTags').value = (l.tags || []).join(', ');
    $('leadReason').value = l.objection_reason || '';
    $('leadForm').scrollIntoView({behavior:'smooth',block:'start'});
  }

  async function saveLead(event) {
    event.preventDefault();
    const btn = $('leadForm').querySelector('button[type="submit"]');
    btn.disabled = true;
    setMessage('leadFormMessage','Saving…');
    try {
      const leadId = $('leadId').value;
      const payload = {
        full_name: $('leadName').value.trim(),
        mobile: $('leadMobile').value.trim(),
        source: $('leadSource').value,
        source_detail: $('leadSourceDetail').value.trim() || null,
        interested_program: $('leadProgram').value.trim() || null,
        pipeline_stage: $('leadStage').value,
        tags: $('leadTags').value.split(',').map(x => x.trim()).filter(Boolean),
        group_preference: $('leadGroupPreference').value,
        common_group_status: $('leadGroupStatus').value,
        class_preference: $('leadClassPreference').value,
        free_class_date: $('leadFreeClassDate').value || null,
        free_class_status: $('leadFreeClassStatus').value,
        course_interest: $('leadInterest').value,
        objection_reason: $('leadReason').value.trim() || null,
        next_followup_at: localDateTimeToIso($('leadNextFollowup').value)
      };
      if (leadId) {
        const { error } = await sb.rpc('crm_update_lead', {
          p_lead_id: leadId,
          p_full_name: payload.full_name,
          p_mobile: payload.mobile,
          p_source: payload.source,
          p_source_detail: payload.source_detail,
          p_interested_program: payload.interested_program,
          p_pipeline_stage: payload.pipeline_stage,
          p_tags: payload.tags,
          p_group_preference: payload.group_preference,
          p_common_group_status: payload.common_group_status,
          p_class_preference: payload.class_preference,
          p_free_class_date: payload.free_class_date,
          p_free_class_status: payload.free_class_status,
          p_course_interest: payload.course_interest,
          p_objection_reason: payload.objection_reason,
          p_next_followup_at: payload.next_followup_at
        });
        if (error) throw error;
      } else {
        const insertPayload = {
          ...payload,
          created_by: state.user.id,
          assigned_to: isAdmin() ? null : state.user.id,
          initial_owner_id: isAdmin() ? null : state.user.id
        };
        const { error } = await sb.from('crm_leads').insert(insertPayload);
        if (error) throw error;
      }
      resetLeadForm();
      await loadLeads();
      await loadAllocations();
      renderStats();
      setMessage('leadFormMessage','Lead saved.','success');
    } catch (err) {
      setMessage('leadFormMessage',err.message || 'Unable to save lead.','error');
    } finally {
      btn.disabled = false;
    }
  }

  async function saveAllocation(id) {
    const btn = document.querySelector(`[data-save-allocation="${CSS.escape(id)}"]`);
    if (btn) btn.disabled = true;
    try {
      const status = document.querySelector(`[data-call-status="${CSS.escape(id)}"]`)?.value;
      const outcome = document.querySelector(`[data-call-outcome="${CSS.escape(id)}"]`)?.value || null;
      const note = document.querySelector(`[data-call-note="${CSS.escape(id)}"]`)?.value || null;
      const { error } = await sb.rpc('crm_update_daily_allocation', {
        p_allocation_id: id,
        p_call_status: status,
        p_call_outcome: outcome,
        p_salesperson_note: note
      });
      if (error) throw error;
      await loadAllocations();
      renderStats();
      showNotice('Call status saved.');
    } catch (err) {
      showNotice(`Could not save call status: ${err.message || err}`);
    } finally { if (btn) btn.disabled = false; }
  }

  async function createAllocation(event) {
    event.preventDefault();
    const btn = $('allocationForm').querySelector('button[type="submit"]');
    btn.disabled = true;
    setMessage('allocationMessage','Allocating…');
    try {
      const { error } = await sb.rpc('crm_create_daily_allocation', {
        p_work_date: $('allocationDate').value,
        p_lead_id: $('allocationLead').value,
        p_salesperson_id: $('allocationSalesperson').value
      });
      if (error) throw error;
      setMessage('allocationMessage','Call allocated.','success');
      await loadAllocations();
      renderStats();
    } catch (err) {
      setMessage('allocationMessage',err.message || 'Allocation failed.','error');
    } finally { btn.disabled = false; }
  }

  async function transferAllocation(id) {
    const select = document.querySelector(`[data-transfer-salesperson="${CSS.escape(id)}"]`);
    const newSalespersonId = select?.value;
    if (!newSalespersonId) {
      showNotice('Choose an active salesperson before transferring this call.');
      return;
    }
    const btn = document.querySelector(`[data-transfer-allocation="${CSS.escape(id)}"]`);
    if (btn) btn.disabled = true;
    try {
      const { error } = await sb.rpc('crm_reassign_daily_allocation', {
        p_allocation_id: id,
        p_new_salesperson_id: newSalespersonId
      });
      if (error) throw error;
      await Promise.all([loadLeads(), loadAllocations()]);
      if (isAdmin()) await loadReviews();
      renderStats();
      showNotice('Call transferred. The previous allocation is preserved as transferred.');
    } catch (err) {
      showNotice(`Could not transfer call: ${err.message || err}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveReview(id) {
    const btn = document.querySelector(`[data-save-review="${CSS.escape(id)}"]`);
    if (btn) btn.disabled = true;
    try {
      const reviewStatus = document.querySelector(`[data-review-status="${CSS.escape(id)}"]`).value;
      const reason = document.querySelector(`[data-review-reason="${CSS.escape(id)}"]`).value.trim();
      const { error } = await sb.rpc('crm_review_daily_allocation', {
        p_allocation_id: id,
        p_review_status: reviewStatus,
        p_reason: reason
      });
      if (error) throw error;
      await loadReviews();
      renderStats();
      showNotice('Admin review saved.');
    } catch (err) {
      showNotice(`Could not save review: ${err.message || err}`);
    } finally { if (btn) btn.disabled = false; }
  }

  function bindEvents() {
    $('loginForm').addEventListener('submit', login);
    $('logoutBtn').addEventListener('click', logout);
    $('leadForm').addEventListener('submit', saveLead);
    $('toggleLeadForm').addEventListener('click', () => {
      $('leadForm').classList.toggle('hidden');
      if (!$('leadForm').classList.contains('hidden')) $('leadName').focus();
    });
    $('cancelLeadForm').addEventListener('click', resetLeadForm);
    $('leadSearch').addEventListener('input', renderLeads);
    $('stageFilter').addEventListener('change', renderLeads);
    $('refreshLeads').addEventListener('click', async () => { try { await loadLeads(); renderStats(); } catch(e) { showNotice(e.message); } });
    $('workDate').addEventListener('change', async () => {
      $('allocationDate').value = $('workDate').value;
      try { await loadAllocations(); if (isAdmin()) await loadReviews(); renderStats(); } catch(e) { showNotice(e.message); }
    });
    $('allocationDate').addEventListener('change', () => $('workDate').value = $('allocationDate').value);
    $('allocationForm').addEventListener('submit', createAllocation);
    $('refreshReviews').addEventListener('click', async () => { try { await loadAllocations(); await loadReviews(); } catch(e) { showNotice(e.message); } });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    bindEvents();
    try { await checkSession(); }
    catch (err) { showLogin(err.message || 'Unable to check CRM session.'); }
  });

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showLogin();
  });
})();
