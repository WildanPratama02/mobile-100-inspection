/* @ds-bundle: {"format": 4, "namespace": "M100", "components": [{"name": "ShoeMap"}, {"name": "List"}, {"name": "Pane"}, {"name": "Button"}, {"name": "CommandButton"}, {"name": "BottomBar"}, {"name": "Chip"}, {"name": "CountBadge"}, {"name": "SelectField"}, {"name": "Dialog"}, {"name": "Toast"}, {"name": "Notice"}, {"name": "OutboxItem"}, {"name": "POListItem"}, {"name": "StatRow"}, {"name": "Top5Row"}, {"name": "PhotoButton"}, {"name": "OptionRow"}, {"name": "Breadcrumb"}, {"name": "HistoryRow"}, {"name": "AreaPill"}, {"name": "Icon"}, {"name": "CheckboxRow"}, {"name": "Stepper"}, {"name": "NumberPad"}]} */
(function(){
var React = window.React, h = React.createElement;
function cx(){ var a=[]; for (var i=0;i<arguments.length;i++){ if(arguments[i]) a.push(arguments[i]); } return a.join(' '); }
function rest(p, omit){ var o={}; for (var k in p){ if (Object.prototype.hasOwnProperty.call(p,k) && omit.indexOf(k)<0) o[k]=p[k]; } return o; }
var ICONS = {
  plus:[['path',{d:'M12 4v16M4 12h16'}]],
  'chevron-down':[['path',{d:'M5 9l7 7 7-7'}]],
  'chevron-right':[['path',{d:'M9 5l7 7-7 7'}]],
  back:[['path',{d:'M15 5l-7 7 7 7'}]],
  home:[['path',{d:'M4 11l8-7 8 7v9h-5v-6H9v6H4z'}]],
  undo:[['path',{d:'M9 14L4 9l5-5'}],['path',{d:'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'}]],
  check:[['path',{d:'M5 12.5l4.5 4.5L19 7.5'}]],
  close:[['path',{d:'M6 6l12 12M18 6L6 18'}]],
  camera:[['path',{d:'M4 8h3l2-3h6l2 3h3v11H4z'}],['circle',{cx:12,cy:13,r:3.5}]],
  download:[['path',{d:'M12 4v11M7 11l5 5 5-5M5 20h14'}]],
  gear:[['circle',{cx:12,cy:12,r:8.4,strokeWidth:3.4,strokeDasharray:'3.3 3.3'}],['circle',{cx:12,cy:12,r:6.6}],['circle',{cx:12,cy:12,r:2.6}]]
};
function Icon(p){
  var parts = ICONS[p.name] || [];
  var style = p.size ? {width:p.size,height:p.size} : undefined;
  return h('svg', {className:cx('m100-ico', p.className), viewBox:'0 0 24 24', style:style, 'aria-hidden': p.label ? undefined : 'true', role: p.label ? 'img' : undefined, 'aria-label': p.label},
    parts.map(function(e,i){ return h(e[0], Object.assign({key:i}, e[1])); }));
}
function Button(p){
  var variant = p.variant || 'secondary', size = p.size || 'md';
  return h('button', Object.assign({type:'button'}, rest(p,['variant','size','icon','block','className','children']), {className:cx('m100-btn','m100-btn--'+variant,'m100-btn--'+size,p.block&&'m100-btn--block',p.className)}),
    p.icon ? h(Icon,{name:p.icon}) : null, p.children);
}
var CMD = {rework:'REWORK', bgrade:'B-GRADE', nodefect:'NO DEFECT', end:'END INSPECTION'};
function CommandButton(p){
  var state = p.state || 'idle';
  return h('button', Object.assign({type:'button'}, rest(p,['mode','state','className','children']), {className:cx('m100-cmd', state==='active'&&'m100-cmd--active', p.className), disabled: state==='disabled' || p.disabled, 'aria-pressed': p.mode!=='end' ? String(state==='active') : undefined}),
    p.children || CMD[p.mode] || '');
}
function BottomBar(p){
  return h('nav', {className:cx('m100-bar',p.className), 'aria-label': p.label || 'Navigasi'},
    (p.items||[]).map(function(it,i){ return h('button',{key:i,type:'button',onClick:it.onClick,disabled:it.disabled}, it.icon?h(Icon,{name:it.icon}):null, it.label); }));
}
var CHIP = {minor:'MINOR', major:'MAJOR', critical:'CRITICAL', rework:'REWORK', bgrade:'B-GRADE'};
var CLS = {1:'minor',2:'major',3:'critical'};
function Chip(p){
  var tone = CLS[p.tone] || p.tone || 'neutral';
  return h('span', {className:cx('m100-chip','m100-chip--'+tone,p.className)}, p.children || CHIP[tone] || '');
}
function CountBadge(p){
  if (p.value == null || p.value === 0) return null;
  return h('span', {className:cx('m100-count',p.className), 'aria-label': p.label}, String(p.value));
}
function SelectField(p){
  return h('div', {className:cx('m100-field',p.className)},
    p.label ? h('span', {id:p.id ? p.id+'-label' : undefined}, p.label) : null,
    h('button', {type:'button', id:p.id, className:'m100-select', 'aria-expanded': String(!!p.open), 'aria-haspopup':'dialog', onClick:p.onClick, disabled:p.disabled},
      p.value != null && p.value !== '' ? h('span', {className: p.mono ? 'm100-mono' : undefined, style: p.mono ? {fontFamily:'var(--font-mono)'} : undefined}, p.value) : h('span',{className:'m100-ph'}, p.placeholder || 'Pilih'),
      h(Icon,{name:'chevron-down'})));
}
function Dialog(p){
  return h('div', {className:cx('m100-dialog', p.wide&&'m100-dialog--wide', p.className), role: p.role || 'dialog', 'aria-label': p.title},
    h('div', {className:'m100-dialog__head'}, h('h3', null, p.title),
      p.onClose !== false ? h('button', {type:'button', className:'m100-dialog__x', onClick:p.onClose, 'aria-label':'Tutup'}, h(Icon,{name:'close'})) : null),
    h('div', {className:'m100-dialog__body'}, p.children));
}
function Toast(p){
  return h('div', {className:cx('m100-toast', p.tone==='error'&&'m100-toast--error', p.floating&&'m100-toast--floating', p.className), role:'status'}, p.children);
}
function Notice(p){
  return h('div', {className:cx('m100-notice', p.tone && 'm100-notice--'+p.tone, p.className), role: p.tone==='danger' ? 'alert' : 'status'},
    p.title ? h('b', null, p.title, ' ') : null, p.children);
}
var OUT = {waiting:'Menunggu', sending:'Mengirim', sent:'Terkirim', failed:'Gagal'};
function OutboxItem(p){
  var st = p.status || 'waiting';
  return h('div', {className:cx('m100-outbox',p.className)},
    h('span', null, h('span',{className:'m100-po-no'}, p.po), p.time ? '  ·  '+p.time : ''),
    h('span', {className:'m100-status m100-status--'+st}, OUT[st]),
    p.detail || p.reason ? h('small', null, p.reason || p.detail) : null);
}
function POListItem(p){
  return h('button', {type:'button', className:cx('m100-po',p.className), 'aria-current': String(!!p.selected), onClick:p.onClick},
    p.po, p.sub ? h('small', null, p.sub) : null, p.live ? h('em', null, p.live) : null, h(CountBadge,{value:p.count, label: p.count ? p.count+' defect' : undefined}));
}
function StatRow(p){
  var v = p.value == null ? '—' : p.value;
  return h('div', {className:cx('m100-stat', p.tone && 'm100-stat--'+p.tone, p.className)},
    h('span', null, p.label), h('b', null, v, p.unit && p.value != null ? h('small', null, p.unit) : null));
}
function PhotoButton(p){
  var st = p.state || 'add';
  if (st === 'attached') return h('button', {type:'button', className:cx('m100-photo','m100-photo--attached',p.className), onClick:p.onClick, 'aria-label': p.label || 'Lihat foto'},
    p.src ? h('img', {src:p.src, alt:''}) : null, h('i', null, h(Icon,{name:'check'})));
  return h('button', {type:'button', className:cx('m100-photo', st==='required'&&'m100-photo--required', p.className), onClick:p.onClick, 'aria-label': st==='required' ? 'Foto wajib' : 'Tambah foto'},
    h(Icon,{name:'camera'}), h('span', null, 'Foto'));
}
function Top5Row(p){
  var hasPhoto = p.photo !== undefined && p.photo !== null;
  return h('div', {className:cx('m100-t5', !hasPhoto&&'m100-t5--nophoto', p.className)},
    h('div', {className:'m100-t5__no'}, p.no),
    h('div', {className:'m100-t5__nm'}, p.name, h('small', null, h(Chip,{tone:p.classification}), p.areas, p.flag ? h('em', {className:'m100-t5__flag'}, p.flag) : null)),
    h('div', {className:'m100-t5__q'}, p.qty),
    hasPhoto ? h('div', null, h(PhotoButton, Object.assign({}, p.photo))) : null);
}
function OptionRow(p){
  var kind = p.kind || 'nav';
  return h('button', {type:'button', className:cx('m100-row','m100-row--'+kind, p.flash&&'m100-flash', p.className), onClick:p.onClick, disabled:p.disabled},
    h('span', {className:'m100-row__t'}, p.title, p.sub ? h('small', null, p.sub) : null),
    kind==='defect' && p.classification ? h(Chip,{tone:p.classification}) : null,
    p.qty ? h('span', {className:'m100-row__q'}, p.qty) : null,
    kind==='nav' && p.count != null ? h('span', {className:'m100-row__n'}, p.count) : null,
    kind==='nav' ? h(Icon,{name:'chevron-right'}) : null);
}
function Breadcrumb(p){
  var items = p.items || [];
  return h('nav', {className:cx('m100-crumbs',p.className), 'aria-label':'Posisi'},
    items.map(function(it,i){ var last = i===items.length-1; var label = typeof it === 'string' ? it : it.label;
      return [i ? h('i',{key:'s'+i,'aria-hidden':'true'},'›') : null,
        h('button', {key:'c'+i, type:'button', className:'m100-crumb', 'aria-current': last ? 'page' : undefined, onClick: last ? undefined : it.onClick}, label)]; }));
}
function HistoryRow(p){
  if (p.head) return h('div', {className:cx('m100-hist','m100-hist--head',p.className)}, h('div',null,'No'), h('div',null,'Defect name'), h('div',null,'Kelas'), h('div',{style:{textAlign:'right'}},'Qty'));
  return h('div', {className:cx('m100-hist', p.flash&&'m100-flash', p.className)},
    h('div', {className:'m100-hist__no'}, p.no + '.'),
    h('div', {className:'m100-hist__nm'}, p.name, p.path ? h('small', null, p.path) : null),
    h('div', null, h(Chip,{tone:p.classification})),
    h('div', {className:'m100-hist__q'}, p.qty));
}
function AreaPill(p){
  var lines = p.lines || [p.label];
  return h('button', {type:'button', style:p.style, className:cx('m100-pill', lines.length>1&&'m100-pill--two', p.general&&'m100-pill--general', p.className), 'aria-pressed': String(!!p.selected), disabled:p.disabled, onClick:p.onClick, 'aria-label': lines.join(' ')},
    lines.map(function(l,i){ return h('span',{key:i}, l); }), h(CountBadge,{value:p.count}));
}
var SHOE_BOX = [352,543,1647,1457];
var SHOE_AREAS = [
  {id:'A06', lines:['TONGUE'],              anchor:[811,634],  dock:[170,130], side:'left'},
  {id:'A08', lines:['INSIDE'],              anchor:[728,790],  dock:[170,205], side:'left'},
  {id:'A05', lines:['COLLAR'],              anchor:[624,832],  dock:[170,280], side:'left'},
  {id:'A04', lines:['HEEL'],                anchor:[489,936],  dock:[170,355], side:'left'},
  {id:'A11', lines:['OUTSOLE /','BONDING'], anchor:[936,1394], dock:[170,560], side:'left'},
  {id:'A07', lines:['EYESTAY/LACE'],        anchor:[1227,728], dock:[616,80],  side:'top'},
  {id:'A02', lines:['VAMP'],                anchor:[1456,832], dock:[830,160], side:'right'},
  {id:'A01', lines:['TOE BOX'],             anchor:[1602,884], dock:[830,240], side:'right'},
  {id:'A09', lines:['BRANDING /','TREATMENT'], anchor:[1123,988], dock:[830,330], side:'right'},
  {id:'A10', lines:['MIDSOLE'],             anchor:[1196,1300],dock:[830,480], side:'right'},
  {id:'A12', lines:['GENERAL'],             anchor:null,       dock:[830,620], side:'right', general:true},
  {id:'A03', lines:['QUARTER'],             anchor:[728,988],  dock:[400,650], side:'bottom'}
];
function ShoeMap(p){
  var box = p.imageBox || SHOE_BOX, layout = p.layout || SHOE_AREAS, st = p.areas || {}, off = !!p.disabled;
  var sc = 580 / (box[2]-box[0]);
  var X = function(x){ return 210 + (x-box[0])*sc; }, Y = function(y){ return 140 + (y-box[1])*sc; };
  var lines = [];
  layout.forEach(function(a){ if (!a.anchor) return; var on = st[a.id] && st[a.id].selected;
    var ax = X(a.anchor[0]), ay = Y(a.anchor[1]);
    lines.push(h('line',{key:'l'+a.id, className:cx('m100-shoemap__line', on&&'m100-shoemap__line--sel'), x1:a.dock[0], y1:a.dock[1], x2:ax, y2:ay}));
    lines.push(h('circle',{key:'d'+a.id, className:cx('m100-shoemap__dot', on&&'m100-shoemap__dot--sel'), cx:ax, cy:ay, r: on ? 7 : 5}));
  });
  return h('div', {className:cx('m100-shoemap', off&&'m100-shoemap--off', p.className), role:'group', 'aria-label': p.label || 'Pilih area sepatu'},
    h('svg', {className:'m100-shoemap__svg', viewBox:'0 0 1000 720', 'aria-hidden':'true'},
      p.src ? h('image', {className:'m100-shoemap__img', href:p.src, x:X(0), y:Y(0), width:2000*sc, height:2000*sc}) : null,
      lines),
    layout.map(function(a){ var v = st[a.id] || {};
      return h(AreaPill, {key:a.id, lines:a.lines, general:a.general, selected:v.selected, count:v.count, disabled: off || v.disabled,
        className:'m100-shoemap__pill--'+a.side, onClick: p.onSelect ? function(){ p.onSelect(a.id); } : undefined,
        style:{left:(a.dock[0]/10)+'%', top:(a.dock[1]/7.2)+'%'}}); }));
}
function List(p){ return h('div', {className:cx('m100-list',p.className), role:p.role}, p.children); }
function Pane(p){ return h('section', {className:cx('m100-pane',p.className), 'aria-label':p.label}, p.children); }
function CheckboxRow(p){
  var on = !!p.checked;
  return h('button', Object.assign({type:'button', role:'checkbox', 'aria-checked':String(on)}, rest(p,['checked','label','sub','onChange','className','children']), {className:cx('m100-check', on&&'m100-check--on', p.className), onClick:function(){ if(!p.disabled && p.onChange) p.onChange(!on); }}),
    h('span',{className:'m100-check__box','aria-hidden':'true'}, on ? h(Icon,{name:'check'}) : null),
    h('span',{className:'m100-check__text'}, p.label, p.sub ? h('small',null,p.sub) : null));
}
function Stepper(p){
  var min = p.min == null ? 1 : p.min, max = p.max == null ? 999 : p.max, v = p.value;
  return h('div', {className:cx('m100-field',p.className)},
    p.label ? h('span',null,p.label) : null,
    h('div',{className:'m100-step', role:'group', 'aria-label': p.label || 'Nilai'},
      h('button',{type:'button',className:'m100-step__b','aria-label':'Kurangi',disabled:p.disabled||v<=min,onClick:function(){ p.onChange&&p.onChange(v-1); }},'−'),
      h('output',{className:'m100-step__v','aria-live':'polite'}, p.format ? p.format(v) : String(v)),
      h('button',{type:'button',className:'m100-step__b','aria-label':'Tambah',disabled:p.disabled||v>=max,onClick:function(){ p.onChange&&p.onChange(v+1); }},'+')));
}
function NumberPad(p){
  var digits = String(p.value == null ? '' : p.value);
  var max = p.max, n = digits === '' ? 0 : parseInt(digits,10);
  var over = max != null && n > max, zero = digits !== '' && n < 1;
  var fmt = function(s){ return s === '' ? '' : s.replace(/\B(?=(\d{3})+(?!\d))/g,'.'); };
  function press(d){ if(!p.onChange) return; var nx = (digits === '0' ? '' : digits) + d; if (nx.length > 9) return; p.onChange(nx); }
  var keys = ['1','2','3','4','5','6','7','8','9'];
  var msg = over ? 'Maksimum '+fmt(String(max))+' pasang' : zero ? 'Minimal 1 pasang' : (p.hint || '');
  return h('div',{className:cx('m100-pad',p.className), role:'group', 'aria-label': p.label || 'Input angka'},
    p.label ? h('span',{className:'m100-pad__label'},p.label) : null,
    h('output',{className:cx('m100-pad__out', (over||zero)&&'m100-pad__out--bad'), 'aria-live':'polite'}, digits === '' ? h('span',{className:'m100-ph'},p.placeholder||'0') : fmt(digits), p.unit ? h('small',null,p.unit) : null),
    h('div',{className:cx('m100-pad__msg',(over||zero)&&'m100-pad__msg--bad')}, msg),
    h('div',{className:'m100-pad__keys'},
      keys.map(function(k){ return h('button',{key:k,type:'button',className:'m100-pad__k',onClick:function(){ press(k); }},k); }),
      h('button',{type:'button',className:'m100-pad__k m100-pad__k--fn',onClick:function(){ p.onChange&&p.onChange(''); }},'HAPUS'),
      h('button',{type:'button',className:'m100-pad__k',onClick:function(){ press('0'); }},'0'),
      h('button',{type:'button',className:'m100-pad__k m100-pad__k--fn','aria-label':'Hapus satu angka',onClick:function(){ p.onChange&&p.onChange(digits.slice(0,-1)); }},h(Icon,{name:'back'}))));
}

window.M100 = Object.assign(window.M100 || {}, {ShoeMap:ShoeMap, List:List, Pane:Pane, Button:Button, CommandButton:CommandButton, BottomBar:BottomBar, Chip:Chip, CountBadge:CountBadge, SelectField:SelectField, Dialog:Dialog, Toast:Toast, Notice:Notice, OutboxItem:OutboxItem, POListItem:POListItem, StatRow:StatRow, Top5Row:Top5Row, PhotoButton:PhotoButton, OptionRow:OptionRow, Breadcrumb:Breadcrumb, HistoryRow:HistoryRow, AreaPill:AreaPill, Icon:Icon, CheckboxRow:CheckboxRow, Stepper:Stepper, NumberPad:NumberPad});
})();
