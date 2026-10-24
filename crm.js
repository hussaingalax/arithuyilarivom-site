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
  const state = { user: null, profile: null, leads: [], totalLeads: 0, allocations: [], users: [], reviews: [] };
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
  function whatsappNumber(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10) digits = `91${digits}`;
    else if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
    return digits;
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
      .select('id,full_name,mobile,location,source,source_detail,interested_program,pipeline_stage,tags,group_preference,common_group_status,class_preference,free_class_date,free_class_status,course_interest,objection_reason,next_followup_at,assigned_to,created_by,initial_owner_id,created_at,updated_at', { count: 'exact' })
      .order('created_at', { ascending: false }).limit(5000);
    if (!isAdmin()) query = query.eq('assigned_to', state.user.id);
    const { data, error, count } = await query;
    if (error) throw error;
    state.leads = data || [];
state.totalLeads = count ?? state.leads.length;
renderLeads();
fillLeadSelect();
renderFollowups();
}

  async function loadUsers() {
    if (!isAdmin()) {
      state.users = [state.profile];
      return;
    }
    const { data, error } = await sb.from('crm_users')
      .select('id,display_name,role,is_active')
      .order('display_name');
    if (error) throw error;
    state.users = data || [];
    fillSalespersonSelect();
    fillAssignedSalespersonFilter();
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
renderFollowups();
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
    $('statLeads').textContent = state.totalLeads;
    renderPipelineStageCounts();
    $('statAllocated').textContent = state.allocations.length;
    $('statCompleted').textContent = state.allocations.filter(a => a.call_status === 'call_completed').length;
    const reviewedIds = new Set(state.reviews.map(r => r.allocation_id));
    $('statReasonPending').textContent = isAdmin()
      ? state.allocations.filter(a => ['assigned','not_called'].includes(a.call_status) && !reviewedIds.has(a.id)).length
      : '—';
  }

  function renderPipelineStageCounts() {
    const host = $('pipelineStageCounts');
    if (!host || !isAdmin()) return;
    const counts = new Map();
    Object.keys(STAGES).forEach(stage => counts.set(stage, 0));
    state.leads.forEach(lead => counts.set(lead.pipeline_stage, (counts.get(lead.pipeline_stage) || 0) + 1));
    host.innerHTML = [...counts.entries()].map(([stage, count]) =>
      `<div class="stage-count-card"><span>${esc(STAGES[stage] || stage)}</span><strong>${count}</strong></div>`
    ).join('');
  }

  function getFilteredLeads() {
    const search = $('leadSearch').value.trim().toLowerCase();
    const stage = $('stageFilter').value;
    return state.leads.filter(l => {
      const matchSearch = !search || `${l.full_name} ${l.mobile} ${l.location || ''} ${l.source_detail || ''} ${l.interested_program || ''}`.toLowerCase().includes(search);
      if (!matchSearch || (stage && l.pipeline_stage !== stage)) return false;
      if (!isAdmin()) return true;
      const equals = (id, value) => !$(id)?.value || String(value ?? '') === $(id).value;
      const dateOnly = value => value ? String(value).slice(0, 10) : '';
      const allocationStatus = $('filterAllocationStatus')?.value || '';
      const assignedFilter = $('filterAssignedSalesperson')?.value || '';
      if (allocationStatus === 'allocated' && !l.assigned_to) return false;
      if (allocationStatus === 'not_allocated' && l.assigned_to) return false;
      if (assignedFilter && String(l.assigned_to || '') !== assignedFilter) return false;
      return equals('filterFreeClassDate', dateOnly(l.free_class_date)) &&
        equals('filterLeadSource', l.source) &&
        equals('filterPipelineStage', l.pipeline_stage) &&
        equals('filterClassPreference', l.class_preference) &&
        equals('filterGroupPreference', l.group_preference) &&
        equals('filterCommonGroupStatus', l.common_group_status) &&
        equals('filterFreeClassStatus', l.free_class_status) &&
        equals('filterCourseInterest', l.course_interest) &&
        equals('filterNextFollowupDate', dateOnly(l.next_followup_at));
    });
  }

  function renderLeads() {
    const rows = getFilteredLeads();
    const countEl = $('leadFilterCount');
    if (countEl) countEl.textContent = `Showing ${rows.length} of ${state.totalLeads} total leads`;
    $('leadsBody').innerHTML = rows.length ? rows.map(l => {
      const owner = state.users.find(u => u.id === l.assigned_to);
      const allocationText = l.assigned_to
        ? `Allocated to ${esc(owner?.display_name || 'Salesperson')}`
        : 'Not allocated';
      return `<tr>
        <td><div class="lead-title">${esc(l.full_name)}</div><div class="cell-sub">${esc(l.mobile)}</div><div class="cell-sub">${esc(l.interested_program || '')}</div></td>
        <td>${esc(l.location || '—')}</td>
        <td>${esc(SOURCES[l.source] || l.source)}<div class="cell-sub">${esc(l.source_detail || '')}</div></td>
        <td><span class="stage">${esc(STAGES[l.pipeline_stage] || l.pipeline_stage)}</span></td>
        <td>${esc(formatDate(l.next_followup_at))}</td>
        <td>${(l.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('') || '—'}</td>
        <td><span class="stage">${allocationText}</span></td>
        <td><div class="inline-actions">
          <a class="button button-quiet" href="tel:${esc(String(l.mobile || '').replace(/[^0-9+]/g, ''))}">Call</a>
          <a class="button button-quiet" href="https://wa.me/${esc(whatsappNumber(l.mobile))}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
          <button class="button button-quiet" type="button" data-edit-lead="${esc(l.id)}">Edit</button>${isAdmin() && !l.assigned_to ? `<button class="button button-quiet" type="button" data-allocate-lead="${esc(l.id)}">Allocate</button>` : ''}
        </div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="8" class="empty">No leads found for this filter.</td></tr>';
    document.querySelectorAll('[data-edit-lead]').forEach(b => b.onclick = () => editLead(b.dataset.editLead));
    document.querySelectorAll('[data-allocate-lead]').forEach(b => b.onclick = () => {
      $('allocationLead').value = b.dataset.allocateLead;
      document.querySelector('[data-tab="callsView"]').click();
      $('allocationSalesperson').focus();
    });
  }

  function fillAssignedSalespersonFilter() {
    const select = $('filterAssignedSalesperson');
    if (!select) return;
    const old = select.value;
    const salespeople = state.users.filter(u => u.role === 'salesperson');
    select.innerHTML = '<option value="">All salespersons</option>' + salespeople
      .map(u => `<option value="${esc(u.id)}">${esc(u.display_name)}</option>`).join('');
    if (salespeople.some(u => u.id === old)) select.value = old;
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

function localFollowupDate(value) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function renderFollowups() {
  const tbody = $('followupsBody');
  if (!tbody) return;

  const selectedDate = $('workDate').value || isoToday();

  const allocatedLeadIds = new Set(
    state.allocations.map(a => String(a.lead_id))
  );

  const dueLeads = state.leads
    .filter(lead =>
      lead.assigned_to &&
      localFollowupDate(lead.next_followup_at) === selectedDate &&
      !allocatedLeadIds.has(String(lead.id))
    )
    .sort((a, b) =>
      String(a.next_followup_at).localeCompare(String(b.next_followup_at))
    );

  tbody.innerHTML = dueLeads.length
    ? dueLeads.map(lead => `
        <tr>
          <td>
            <div class="lead-title">${esc(lead.full_name || 'Unnamed lead')}</div>
          </td>
          <td>${esc(lead.mobile || '')}</td>
          <td>${esc(
            lead.next_followup_at
              ? new Date(lead.next_followup_at).toLocaleString('en-IN', {
                  dateStyle: 'medium',
                  timeStyle: 'short'
                })
              : ''
          )}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" class="empty">No follow-ups due for this date.</td></tr>';
}
  
  function renderAllocations() {
    $('allocationsBody').innerHTML = state.allocations.length ? state.allocations.map(a => {
      const lead = state.leads.find(l => l.id === a.lead_id);
      const person = state.users.find(u => u.id === a.salesperson_id);
      const statusOptions = Object.entries(CALL_STATUSES).map(([k,v]) => `<option value="${k}" ${a.call_status===k?'selected':''}>${esc(v)}</option>`).join('');
      return `<tr>
        <td><div class="lead-title">${esc(lead?.full_name || 'Lead unavailable')}</div><div class="cell-sub">${esc(lead?.mobile || '')}</div><div class="inline-actions allocation-lead-actions">${lead ? `<a class="button button-quiet" href="tel:${esc(String(lead.mobile || '').replace(/[^0-9+]/g, ''))}">Call</a><a class="button button-quiet" href="https://wa.me/${esc(whatsappNumber(lead.mobile))}" target="_blank" rel="noopener noreferrer">WhatsApp</a><button class="button button-quiet" type="button" data-edit-allocation-lead="${esc(lead.id)}">Edit lead</button>${isAdmin() ? `<button class="button button-quiet" type="button" data-allocate-from-call="${esc(lead.id)}">Allocate</button>` : ''}` : ''}</div></td>
        <td>${esc(person?.display_name || (a.salesperson_id === state.user.id ? state.profile.display_name : 'Salesperson'))}</td>
        <td>${isAdmin() ? `<span class="stage">${esc(CALL_STATUSES[a.call_status] || a.call_status)}</span>` : `<select class="small-select" data-call-status="${esc(a.id)}">${statusOptions}</select>`}</td>
        <td>${isAdmin() ? `${esc(a.call_outcome || '')}<div class="cell-sub">${esc(a.salesperson_note || '')}</div>` : `<input class="small-input" data-call-outcome="${esc(a.id)}" value="${esc(a.call_outcome || '')}" placeholder="Outcome"><input class="small-input" data-call-note="${esc(a.id)}" value="${esc(a.salesperson_note || '')}" placeholder="Note">`}</td>
        <td>${isAdmin() ? (a.call_status === 'assigned' || a.call_status === 'not_called' ? `<button class="button button-quiet" type="button" data-review-allocation="${esc(a.id)}">Review</button>` : '—') : `<button class="button button-primary" type="button" data-save-allocation="${esc(a.id)}">Save status</button>`}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">No calls allocated for this date.</td></tr>';
    document.querySelectorAll('[data-edit-allocation-lead]').forEach(b => b.onclick = () => {
      document.querySelector('[data-tab="leadsView"]').click();
      editLead(b.dataset.editAllocationLead);
    });
    document.querySelectorAll('[data-allocate-from-call]').forEach(b => b.onclick = () => {
      $('allocationLead').value = b.dataset.allocateFromCall;
      $('allocationDate').value = $('workDate').value || isoToday();
      $('allocationForm').classList.remove('hidden');
      $('allocationSalesperson').focus();
      $('allocationForm').scrollIntoView({behavior:'smooth',block:'center'});
    });
    document.querySelectorAll('[data-save-allocation]').forEach(b => b.onclick = () => saveAllocation(b.dataset.saveAllocation));
    document.querySelectorAll('[data-review-allocation]').forEach(b => b.onclick = () => {
      document.querySelector('[data-tab="reviewView"]').click();
      const select = document.querySelector(`[data-review-status="${CSS.escape(b.dataset.reviewAllocation)}"]`);
      if (select) select.focus();
    });
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
    $('leadLocation').value = l.location || '';
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
        location: $('leadLocation').value.trim() || null,
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
        const { error } = await sb.rpc('crm_update_lead_with_location', {
          p_lead_id: leadId,
          p_full_name: payload.full_name,
          p_location: payload.location,
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
  if (err.code === '23505') {
    setMessage(
      'leadFormMessage',
      'This mobile number is already registered. Please search for the existing lead.',
      'error'
    );
  } else {
    setMessage(
      'leadFormMessage',
      err.message || 'Unable to save lead.',
      'error'
    );
  }
} finally {
      
      btn.disabled = false;
    }
  }


  function exportLeadsCsv() {
    const rows = getFilteredLeads();
    if (!rows.length) { showNotice('No leads to export for the current filter.'); return; }
    const headers = ['Name','Mobile','Location','Lead Source','Source Details','Interested Program','Pipeline Stage','Assigned Salesperson','Allocation Status','Group Preference','Common Group Status','Class Preference','Free Class Date','Free Class Status','Course Interest','Next Follow-up','Tags','Notes','Created At'];
    const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const csv = [headers, ...rows.map(l => {
      const owner = state.users.find(u => u.id === l.assigned_to);
      return [l.full_name,l.mobile,l.location,SOURCES[l.source] || l.source,l.source_detail,l.interested_program,STAGES[l.pipeline_stage] || l.pipeline_stage,owner?.display_name || '',l.assigned_to ? 'Allocated' : 'Not allocated',l.group_preference,l.common_group_status,l.class_preference,l.free_class_date,l.free_class_status,l.course_interest,l.next_followup_at,(l.tags || []).join('; '),l.objection_reason,l.created_at];
    })].map(row => row.map(cell).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `arithuyil-crm-leads-${isoToday()}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    showNotice(`Exported ${rows.length} lead(s).`);
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
    $('stageFilter').addEventListener('change', () => {
      if ($('filterPipelineStage')) $('filterPipelineStage').value = $('stageFilter').value;
      renderLeads();
    });
    ['filterFreeClassDate','filterLeadSource','filterPipelineStage','filterClassPreference','filterGroupPreference','filterCommonGroupStatus','filterFreeClassStatus','filterCourseInterest','filterNextFollowupDate','filterAllocationStatus','filterAssignedSalesperson'].forEach(id => {
      $(id)?.addEventListener('change', () => {
        if (id === 'filterPipelineStage') $('stageFilter').value = $('filterPipelineStage').value;
        renderLeads();
      });
    });
    $('clearLeadFilters')?.addEventListener('click', () => {
      ['filterFreeClassDate','filterLeadSource','filterPipelineStage','filterClassPreference','filterGroupPreference','filterCommonGroupStatus','filterFreeClassStatus','filterCourseInterest','filterNextFollowupDate','filterAllocationStatus','filterAssignedSalesperson'].forEach(id => { if ($(id)) $(id).value = ''; });
      $('stageFilter').value = '';
      renderLeads();
    });
    $('refreshLeads').addEventListener('click', async () => { try { await loadLeads(); renderStats(); } catch(e) { showNotice(e.message); } });
    $('exportLeads').addEventListener('click', exportLeadsCsv);
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
