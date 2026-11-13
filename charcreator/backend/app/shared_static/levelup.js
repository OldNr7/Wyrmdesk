// Guided level-up: a dialog that goes through what changes at the next level, step by step.
// "Weiter" only works once the step is complete. Needs charsheet.js (pcData, pcDerived, the library
// helpers) and the page's state (spells of the class, state.options for subclasses and features).
//
// openLevelUp(entity, save): save(body) stores the character (PUT body of the sheet plus hp_gain, so
// the current HP rise along with the maximum) and returns the saved character or throws.

// Level at which a class picks its subclass (SRD 5.1); the 2024 rules and other classes: 3.
const SUBCLASS_LEVEL = { cleric: 1, sorcerer: 1, warlock: 1, druid: 2, wizard: 2 };
// Ability Score Improvement levels, if the library has no class entry saying otherwise.
const ASI_LEVELS = { fighter: [4, 6, 8, 12, 14, 16, 19], rogue: [4, 8, 10, 12, 16, 19] };
const ASI_DEFAULT = [4, 8, 12, 16, 19];

const canLevelUp = (entity) => {
  const d = pcData(entity);
  return !!classInfo(d.class_key, d.class_ref) && (parseInt(d.level, 10) || 1) < 20;
};

function asiLevels(d) {
  const o = classOption(d);
  const f = o && ((o.data || {}).features || []).find((f) => /ability score improvement/i.test(f.name || ""));
  return f && f.levels && f.levels.length ? f.levels : ASI_LEVELS[d.class_key] || ASI_DEFAULT;
}

// Features of class and subclass gained at exactly this level.
function featuresAt(d, lvl, subRef) {
  const out = [];
  for (const o of [classOption(d), subRef && optionById(subRef.id)]) {
    if (!o) continue;
    ((o.data || {}).features || []).forEach((f, i) => {
      if (f.levels && f.levels.includes(lvl) && !/ability score improvement/i.test(f.name || "")) out.push({ o, f, i });
    });
  }
  return out;
}

const raceHasToughness = (d) => {
  const race = d.race_ref && optionById(d.race_ref.id);
  return !!race && ((race.data || {}).traits || []).some((t) => /dwarven toughness/i.test(t.name || ""));
};

function openLevelUp(entity, save) {
  const d = pcData(entity);
  const x = pcDerived(d);
  const cls = classInfo(d.class_key, d.class_ref);
  const lvl = x.lvl + 1;
  const c = {
    sub: d.subclass_ref ? null : undefined, // the newly chosen subclass (ref or {name})
    asiMode: "points", // points | feat
    asi: {},
    feat: "", // a feat's name typed in (only without feats in the library)
    featId: "", // the chosen feat of the library
    featAsi: {}, // points of its ability score increase
    hpMode: null, // avg | roll
    hpRoll: null,
    cantrips: new Set(),
    spells: new Set(),
    off: new Set(), // keys of unticked fixed subclass grants
    skip: new Set(), // keys of skipped subclass choices
    picks: {}, // subclass choice key -> Set of skill keys or spell ids
    lang: "",
  };

  // The feat chosen instead of the ability score improvement: its library entry and the free points
  // of its increase ("+1 Strength or Dexterity"), which go into the sheet's ability_choice.
  const featOption = () => (c.asiMode === "feat" && c.featId ? optionById(Number(c.featId)) : null);
  const featChoices = () => (((featOption() || {}).data || {}).asi || {}).choices || [];
  const featPoints = () => featChoices().reduce((s, ch) => s + ch.points, 0);

  // The character as it would be after the steps so far (for spells, CON and HP).
  const after = () => {
    const base = { ...d.ability_base };
    if (c.asiMode === "points") for (const [k, n] of Object.entries(c.asi)) base[k] = (Number(base[k]) || 0) + n;
    const o = featOption();
    // Stored in German ("Stufe 4"), shown through featSourceLabel().
    const feats = o ? [...d.feats, { ...optionRef(o), source: `Stufe ${lvl}` }] : d.feats;
    const choice = { ...d.ability_choice };
    if (o) for (const [k, n] of Object.entries(c.featAsi)) choice[k] = (Number(choice[k]) || 0) + n;
    const bonus = abilityBonus({ ...d, feats, ability_choice: choice });
    const nd = { ...d, level: lvl, ability_base: base, feats, ability_choice: choice, ability_bonus: bonus,
      subclass_ref: c.sub && c.sub.id ? c.sub : d.subclass_ref };
    nd.abilities = Object.fromEntries(ABILITIES.map(([k]) => [k, base[k] === null || base[k] === undefined || base[k] === "" ? null : abilityTotal(Number(base[k]), bonus[k])]));
    return { nd, nx: pcDerived(nd) };
  };

  // The feat step: the library's feats (not origin feats, not the ones the character has unless
  // repeatable), then the points of the chosen feat's increase. Without feats in the library just a
  // name, as before.
  const featHtml = () => {
    const all = charOptions("feats");
    if (!all.length) {
      return `<input class="lu-feat" value="${esc(c.feat)}" placeholder="${t("Name des Talents, z.B. Zäh")}" />
        <p class="pc-hint">${t("Das Talent kommt unter „Merkmale &amp; Fähigkeiten“; seine Wirkung trägst du danach selbst ein.")}</p>`;
    }
    const have = new Set(d.feats.map((f) => f.id));
    const list = all
      .filter((o) => (o.data || {}).feat_type !== "Origin" || o.id === Number(c.featId))
      .filter((o) => !have.has(o.id) || (o.data || {}).repeatable)
      .filter((o) => !/^ability score improvement$/i.test(o.name_en || ""));
    const groups = {};
    for (const o of list) (groups[(o.data || {}).feat_type || ""] ||= []).push(o);
    const opts = Object.keys(groups)
      .sort((a, b) => (a === "General" ? -1 : b === "General" ? 1 : a.localeCompare(b)))
      .map((k) => `<optgroup label="${esc(FEAT_TYPE_NAMES[k] || k || t("Weitere"))}">${groups[k].map((o) => {
        const pre = (o.data || {}).prerequisite;
        return `<option value="${o.id}" ${String(o.id) === String(c.featId) ? "selected" : ""}>${esc(optionLabel(o))}${pre ? ` – ${esc(pre)}` : ""}</option>`;
      }).join("")}</optgroup>`)
      .join("");
    const o = featOption();
    let points = "";
    if (o && featChoices().length) {
      const used = Object.values(c.featAsi).reduce((s, n) => s + n, 0);
      const max = asiChoiceMax(featChoices());
      const now = after().nd.abilities;
      const rows = ABILITIES.filter(([k]) => max[k]).map(([k, short, long]) => {
        const n = c.featAsi[k] || 0;
        const canAdd = used < featPoints() && n < max[k] && now[k] !== null && now[k] < ABILITY_MAX;
        return `<div class="lu-asi-row"><span>${long} (${short})</span><span>${now[k] ?? "–"}</span>
          <button type="button" class="ghost pc-btn" data-feat-asi="${k}" data-step="-1" ${n ? "" : "disabled"}>−</button>
          <button type="button" class="ghost pc-btn" data-feat-asi="${k}" data-step="1" ${canAdd ? "" : "disabled"}>+</button></div>`;
      }).join("");
      points = `<p><b>${t("Attributserhöhung des Talents:")}</b> ${esc(asiText(o.data.asi))}</p><div class="lu-asi">${rows}</div>
        <p class="pc-hint">${t("Verteilt: {used} von {points}", { used, points: featPoints() })}</p>`;
    }
    const pre = o && o.data && o.data.prerequisite;
    return `<select class="lu-feat-pick"><option value="">${t("-- Talent --")}</option>${opts}</select>
      ${o ? `<p><span class="cs-info-link" ${infoAttr(`opt:${o.id}`)}>${esc(optionLabel(o))}</span>${pre ? ` <span class="pc-hint">${t("Voraussetzung: {text} (bitte selbst prüfen)", { text: esc(pre) })}</span>` : ""}</p>` : ""}
      ${points}
      <p class="pc-hint">${t("Das Talent kommt unter „Talente“ aufs Blatt; was es sonst bewirkt (Initiative, Zauber …), trägst du danach selbst ein.")}</p>`;
  };

  const subLevel = d.class_key in SUBCLASS_LEVEL ? SUBCLASS_LEVEL[d.class_key] : 3;
  const needsSub = !d.subclass_ref && !d.subclass && lvl >= subLevel;
  const subList = subclassesFor(cls);
  const asiAt = asiLevels(d).includes(lvl);

  // Spells to pick now: new cantrips, new known spells, the wizard's two spellbook entries.
  const spellNeeds = () => {
    const { nx } = after();
    if (!nx.spell) return null;
    const cantrips = Math.max(0, (nx.spell.cantrips || 0) - ((x.spell && x.spell.cantrips) || 0));
    let spells = 0;
    if (nx.spell.known !== null) spells = Math.max(0, nx.spell.known - ((x.spell && x.spell.known) || 0));
    else if (isSpellbook(d)) spells = 2;
    const chosen = new Set([...d.spell_list.map((s) => String(s.id)), ...Object.values(c.picks).flatMap((set) => [...set])]);
    const pool = classSpells(d.class_key).filter((sp) => !chosen.has(String(sp.id)));
    const cantripPool = pool.filter((sp) => sp.level_int === 0);
    const spellPool = pool.filter((sp) => sp.level_int >= 1 && sp.level_int <= nx.maxSpellLevel);
    // Fewer in the library than the rules allow: as many as there are.
    return {
      nx,
      cantrips: Math.min(cantrips, cantripPool.length), cantripPool,
      spells: Math.min(spells, spellPool.length), spellPool,
      short: cantrips > cantripPool.length || spells > spellPool.length,
    };
  };
  const sn = spellNeeds();
  const hasSpellStep = !!sn && (sn.cantrips > 0 || sn.spells > 0 || sn.short);

  // What the subclass gives up to the new level (subclassGrants, from the feature texts). Fixed things
  // (proficiencies, skills, spells, domain spells) are caught up on if missing, so a subclass chosen in
  // the editor gets its earlier ones too; each can be unticked. Choices: skills only when the feature
  // is new, spells as long as fewer carry the feature's mark than it grants.
  const subPlan = () => {
    const ref = c.sub && c.sub.id ? c.sub : d.subclass_ref;
    const fresh = !!(c.sub && c.sub.id);
    const list = subclassGrants(d, lvl, ref);
    if (!list.length) return null;
    const o = list[0].o;
    const parentEn = String(o.parent || (cls && cls.en) || "");
    const profText = `${d.proficiencies || ""} ${cls.profs || ""}`.toLowerCase();
    const has = (name) => d.spell_list.findIndex((s) => s.name.toLowerCase() === String(name).toLowerCase() || (libSpellByName(name) && String(s.id) === String(libSpellByName(name).id)));
    const fixed = [];
    const seen = new Set();
    const spell = (name, src, extra = {}) => {
      const k = `spell:${String(name).toLowerCase()}`;
      if (seen.has(k)) return;
      seen.add(k);
      const at = has(name);
      if (at >= 0 && d.spell_list[at].extra) return;
      const sp = libSpellByName(name);
      fixed.push({ key: k, kind: "spell", name: sp ? sp.name : name.replace(/\b\w/g, (ch) => ch.toUpperCase()), sp, at, src, ...extra });
    };
    const choices = [];
    for (const { f, i, g, at } of list) {
      const src = localized(f.name, f.name_de);
      for (const p of g.profs || []) {
        const de = profDe(p);
        if (!profText.includes(de.toLowerCase()) && !profText.includes(String(p).toLowerCase()) && !seen.has(`prof:${de}`)) {
          seen.add(`prof:${de}`);
          fixed.push({ key: `prof:${de}`, kind: "prof", label: de, src });
        }
      }
      for (const k of g.skills || []) {
        if (!d.skill_prof.includes(k) && !seen.has(`skill:${k}`)) {
          seen.add(`skill:${k}`);
          fixed.push({ key: `skill:${k}`, kind: "skill", skill: k, src });
        }
      }
      for (const s of g.spells || []) spell(s.name, src, { ritual_only: !!s.ritual_only });
      for (const row of g.table || []) {
        if (row.level > lvl) continue;
        // Level of a spell missing from the library, from the class level it comes with.
        const guess = cls.spell && cls.spell.type === "full" ? Math.ceil(row.level / 2)
          : cls.spell && cls.spell.type === "half" ? ({ 3: 1, 5: 2, 9: 3, 13: 4, 17: 5 })[row.level] : null;
        for (const name of row.spells) spell(name, src, { guess });
      }
      const now = fresh || at === lvl;
      if (g.skill_choice && now) choices.push({ key: `${o.id}:${i}:skills`, kind: "skills", src, f, ...g.skill_choice });
      (g.spell_choice || []).forEach((ch, j) => {
        const key = `${o.id}:${i}:${j}`;
        const done = d.spell_list.filter((s) => s.grant === key).length;
        if (done < ch.n) choices.push({ key, kind: "spells", src, f, ...ch, n: ch.n - done });
      });
      if (g.languages && now) choices.push({ key: `${o.id}:${i}:lang`, kind: "languages", src, f, n: g.languages });
    }
    return { o, parentEn, fixed, choices };
  };
  // Spells a choice offers: by list, school and level; also ones already on the sheet without a mark
  // (picking one marks it), none another choice holds.
  const choicePool = (ch) => {
    const { nx } = after();
    const lists = ch.lists ? ch.lists.map((l) => l.toLowerCase()) : null;
    const max = (nx.maxSpellLevel || 0);
    const other = new Set([
      ...d.spell_list.filter((s) => s.grant && s.grant !== ch.key).map((s) => String(s.id)),
      ...Object.entries(c.picks).filter(([k]) => k !== ch.key).flatMap(([, set]) => [...set]),
    ]);
    return spellLibrary().filter((sp) => {
      if (other.has(String(sp.id))) return false;
      if (lists && !String(sp.dnd_class || "").toLowerCase().split(",").map((x) => x.trim()).some((x) => lists.includes(x))) return false;
      if (ch.school && String(sp.school || "").toLowerCase() !== ch.school) return false;
      if (ch.cantrip) return sp.level_int === 0;
      if (ch.spell_level) return sp.level_int === ch.spell_level;
      return sp.level_int <= max;
    });
  };
  const choiceNeed = (ch) => (ch.kind === "skills" ? ch.n : ch.kind === "spells" ? Math.min(ch.n, choicePool(ch).length) : 0);
  const hasSubStep = () => {
    const p = subPlan();
    return !!p && (p.fixed.length > 0 || p.choices.length > 0);
  };
  // What the subclass step changes on the sheet.
  const subResult = () => {
    if (!hasSubStep()) return null;
    const p = subPlan();
    const on = p.fixed.filter((e) => !c.off.has(e.key));
    const mark = { extra: true, source: p.o.name, class_en: p.parentEn };
    const r = {
      profs: on.filter((e) => e.kind === "prof").map((e) => e.label),
      skills: on.filter((e) => e.kind === "skill").map((e) => e.skill),
      expertise: [],
      spells: [], // new spell_list entries
      marked: new Map(), // index in d.spell_list -> fields to set
      lang: "",
    };
    const entry = (sp, name, level, more) => ({
      id: sp ? sp.id : null, name: sp ? sp.name : name, level: sp ? sp.level_int : level ?? null, prepared: false, ...mark, ...more,
    });
    for (const e of on.filter((e) => e.kind === "spell")) {
      const more = e.ritual_only ? { ritual_only: true } : {};
      if (e.at >= 0) r.marked.set(e.at, { ...mark, ...more });
      else r.spells.push(entry(e.sp, e.name, e.guess, more));
    }
    for (const ch of p.choices) {
      if (ch.kind === "languages") {
        r.lang = c.lang.trim();
        continue;
      }
      if (c.skip.has(ch.key)) continue;
      for (const v of c.picks[ch.key] || []) {
        if (ch.kind === "skills") {
          if (!d.skill_prof.includes(v)) r.skills.push(v);
          if (ch.expertise) r.expertise.push(v);
          continue;
        }
        const at = d.spell_list.findIndex((s) => String(s.id) === String(v));
        if (at >= 0) r.marked.set(at, { ...mark, grant: ch.key });
        else {
          const sp = findSpell({ id: v });
          r.spells.push(entry(sp, sp.name, null, { grant: ch.key }));
        }
      }
    }
    return r;
  };
  const subSummary = () => {
    const r = subResult();
    if (!r) return [];
    const skillName = (k) => (SKILLS.find((s) => s[0] === k) || [, k])[1];
    const spells = [...r.spells.map((s) => s.name), ...[...r.marked.keys()].map((i) => d.spell_list[i].name)];
    return [
      r.profs.length && t("Übungen: {list}", { list: r.profs.map(esc).join(", ") }),
      r.skills.length && t("Fertigkeiten: {list}", { list: r.skills.map((k) => esc(skillName(k))).join(", ") }),
      r.expertise.length && t("Expertise: {list}", { list: r.expertise.map((k) => esc(skillName(k))).join(", ") }),
      spells.length && t("Unterklassen-Zauber: {list}", { list: spells.map(esc).join(", ") }),
      r.lang && t("Sprachen: {list}", { list: esc(r.lang) }),
    ];
  };

  const hpGain = () => {
    const { nx } = after();
    const die = cls.hitDie;
    const roll = c.hpMode === "avg" ? die / 2 + 1 : c.hpRoll;
    if (!roll) return null;
    // A higher CON modifier counts for every earlier level too.
    const retro = (nx.m.con - x.m.con) * x.lvl;
    return { roll, con: nx.m.con, retro, tough: raceHasToughness(d) ? 1 : 0, total: Math.max(1, roll + nx.m.con) + retro + (raceHasToughness(d) ? 1 : 0) };
  };

  const esc = (v) => escapeHtml(String(v ?? ""));
  const allSteps = [
    {
      title: t("Übersicht"),
      html: () => {
        const { nx } = after();
        const feats = featuresAt(d, lvl, d.subclass_ref);
        const featList = feats.length
          ? `<ul class="pc-info-list">${feats.map(({ o, f, i }) => `<li><span class="cs-info-link" ${infoAttr(`opt:${o.id}:features:${i}`)}>${esc(localized(f.name, f.name_de))}</span> <span class="pc-hint">(${esc(optName(o))})</span></li>`).join("")}</ul>`
          : `<p class="pc-hint">${classOption(d) ? t("Keine neuen Klassenmerkmale aus der Bibliothek auf dieser Stufe.") : t("Die Klasse ist nicht in der Bibliothek: neue Merkmale bitte im Regelwerk nachschlagen.")}</p>`;
        return `<p>${t("<b>{name}</b> steigt als {class} von Stufe {from} auf <b>Stufe {to}</b>.", { name: esc(d.name), class: esc(cls.label), from: x.lvl, to: lvl })}</p>
          ${nx.prof !== x.prof ? `<p>${t("Übungsbonus steigt auf <b>{n}</b>.", { n: signed(nx.prof) })}</p>` : ""}
          <p><b>${t("Neu auf Stufe {n}:", { n: lvl })}</b></p>${featList}
          <p class="pc-hint">${t("Die Merkmale stehen danach auf dem Blatt unter „Merkmale &amp; Fähigkeiten“. Ressourcen wie Kampfrausch oder Zauberplätze rechnet das Blatt selbst nach.")}</p>`;
      },
      valid: () => true,
    },
    needsSub && {
      title: t("Unterklasse"),
      html: () => {
        if (!subList.length) {
          return `<p>${t("Auf Stufe {n} wählt {class} eine Unterklasse. In der Bibliothek ist keine vorhanden: Name eintragen.", { n: subLevel, class: esc(cls.label) })}</p>
            <input class="lu-sub-text" value="${esc(c.sub ? c.sub.name : "")}" placeholder="${t("Unterklasse")}" />`;
        }
        return `<p>${t("Ab Stufe {n} gehört {name} einer Unterklasse an. Wähle eine:", { n: subLevel, name: esc(d.name) })}</p>
          <div class="lu-choices">${subList
            .map((o) => `<label class="lu-choice"><input type="radio" name="lu-sub" value="${o.id}" ${c.sub && c.sub.id === o.id ? "checked" : ""} />
              <span class="cs-info-link" ${infoAttr(`opt:${o.id}`)}>${esc(optionLabel(o))}</span></label>`)
            .join("")}</div>`;
      },
      valid: () => (c.sub && c.sub.name ? true : t("Unterklasse wählen.")),
    },
    {
      title: t("Aus der Unterklasse"),
      show: hasSubStep,
      html: () => {
        const p = subPlan();
        const skillName = (k) => (SKILLS.find((s) => s[0] === k) || [, k])[1];
        const fixedRow = (e) => {
          const what = e.kind === "prof" ? t("Übung: <b>{name}</b>", { name: esc(e.label) })
            : e.kind === "skill" ? t("Fertigkeit: <b>{name}</b>", { name: esc(skillName(e.skill)) })
            : `${e.sp && e.sp.level_int === 0 ? t("Zaubertrick:") : t("Zauber:")} <span class="cs-info-link" ${infoAttr(`spell:${e.sp ? e.sp.id : ""}:${e.name}`)}>${esc(e.name)}</span>${e.ritual_only ? ` ${t("(nur als Ritual)")}` : ""}${e.at >= 0 ? ` – ${t("schon eingetragen, wird als Unterklassen-Zauber markiert")}` : ""}${e.sp ? "" : ` <span class="pc-warn">${t("nicht in der Zauberliste")}</span>`}`;
          return `<label class="lu-choice"><input type="checkbox" data-fixed="${esc(e.key)}" ${c.off.has(e.key) ? "" : "checked"} /> ${what} <span class="pc-hint">(${esc(e.src)})</span></label>`;
        };
        const choiceHtml = (ch) => {
          const skip = c.skip.has(ch.key);
          const set = c.picks[ch.key] || new Set();
          const head = `<p><b>${esc(ch.src)}</b>: `;
          const skipBox = `<label class="lu-choice pc-hint"><input type="checkbox" data-skip="${esc(ch.key)}" ${skip ? "checked" : ""} /> ${t("Überspringen (schon von Hand erledigt)")}</label>`;
          if (ch.kind === "languages") {
            return `${head}${t("{what} deiner Wahl.", { what: tn(ch.n, "{n} Sprache", "{n} Sprachen") })}</p>
              <input class="lu-lang" value="${esc(c.lang)}" placeholder="${t("z.B. Drakonisch, Elfisch")}" />`;
          }
          if (ch.kind === "skills") {
            const from = ch.from || SKILLS.map((s) => s[0]);
            const need = ch.n;
            const opts = from
              .filter((k) => ch.expertise || !d.skill_prof.includes(k))
              .map((k) => `<label class="lu-choice"><input type="checkbox" data-pick="${esc(ch.key)}" value="${k}" ${set.has(k) ? "checked" : ""} ${!set.has(k) && set.size >= need ? "disabled" : ""} /> ${esc(skillName(k))}</label>`)
              .join("");
            return `${head}${tn(need, "{n} Fertigkeit", "{n} Fertigkeiten")}${ch.expertise ? ` ${t("mit doppeltem Übungsbonus (Expertise)")}` : ""}: ${t("{n} von {max}", { n: set.size, max: need })}</p>
              ${skip ? "" : `<div class="lu-choices">${opts}</div>`}${skipBox}`;
          }
          const pool = choicePool(ch);
          const need = choiceNeed(ch);
          const what = ch.cantrip ? (ch.n > 1 ? t("Zaubertricks") : t("Zaubertrick")) : ch.spell_level ? t("Zauber des Grades {n}", { n: ch.spell_level }) : t("Zauber (oder Zaubertricks)");
          const from = `${ch.school ? `${t("der Schule {school}", { school: esc(ch.school) })} ` : ""}${ch.lists ? t("von der Liste: {lists}", { lists: ch.lists.map((l) => esc(classLabelEn(l))).join(", ") }) : t("von beliebigen Listen")}`;
          const byLevel = {};
          for (const sp of pool) (byLevel[sp.level_int] = byLevel[sp.level_int] || []).push(sp);
          const onSheet = new Set(d.spell_list.map((s) => String(s.id)));
          const opts = Object.entries(byLevel)
            .map(([l, list]) => `<div class="pc-spell-level-label">${spellGroupLabel(Number(l))}</div>${list
              .map((sp) => `<label class="lu-choice"><input type="checkbox" data-pick="${esc(ch.key)}" value="${sp.id}" ${set.has(String(sp.id)) ? "checked" : ""} ${!set.has(String(sp.id)) && set.size >= need ? "disabled" : ""} />
                <span class="cs-info-link" ${infoAttr(`spell:${sp.id}:${sp.name}`)}>${esc(sp.name)}</span>${onSheet.has(String(sp.id)) ? ` <span class="pc-hint">${t("(schon eingetragen)")}</span>` : ""}</label>`)
              .join("")}`)
            .join("");
          return `${head}${ch.n} ${what} ${from}, ${t("gilt als {class}-Zauber", { class: esc(classLabelEn(p.parentEn)) })}: ${t("{n} von {max}", { n: set.size, max: need })}</p>
            ${skip ? "" : need ? `<div class="lu-spells">${opts}</div>` : `<p class="pc-warn">${t("Keine passenden Zauber in der Zauberliste.")}</p>`}${skipBox}`;
        };
        return `<p>${t("Was <b>{name}</b> bis Stufe {n} mitbringt:", { name: esc(optName(p.o)), n: lvl })}</p>
          ${p.fixed.length ? `<div class="lu-choices">${p.fixed.map(fixedRow).join("")}</div>` : ""}
          ${p.choices.map(choiceHtml).join("")}
          <p class="pc-hint">${t("Unterklassen-Zauber sind immer vorbereitet und zählen nicht zu den bekannten oder vorbereiteten Zaubern (U auf dem Blatt). Erkannt aus den englischen Merkmalstexten der Bibliothek: Häkchen entfernen, was nicht passt.")}</p>`;
      },
      valid: () => {
        const p = subPlan();
        for (const ch of p.choices) {
          if (ch.kind === "languages" || c.skip.has(ch.key)) continue;
          if ((c.picks[ch.key] || new Set()).size !== choiceNeed(ch)) return t("{source}: Auswahl treffen oder überspringen.", { source: ch.src });
        }
        return true;
      },
    },
    asiAt && {
      title: t("Attribute"),
      html: () => {
        const used = Object.values(c.asi).reduce((s, n) => s + n, 0);
        const rows = ABILITIES.map(([k, short, long]) => {
          const n = c.asi[k] || 0;
          const total = d.abilities[k];
          const now = total === null ? "–" : abilityTotal(total, n);
          const canAdd = used < 2 && n < 2 && total !== null && total + n < ABILITY_MAX;
          return `<div class="lu-asi-row"><span>${long} (${short})</span><span>${total ?? "–"}${n ? ` → <b>${now}</b>` : ""}</span>
            <button type="button" class="ghost pc-btn" data-asi="${k}" data-step="-1" ${n ? "" : "disabled"}>−</button>
            <button type="button" class="ghost pc-btn" data-asi="${k}" data-step="1" ${canAdd ? "" : "disabled"}>+</button></div>`;
        }).join("");
        return `<p>${t("Attributswerterhöhung: zwei Punkte, entweder +2 auf ein Attribut oder je +1 auf zwei. Kein Wert über {max}.", { max: ABILITY_MAX })}</p>
          <div class="lu-choices">
            <label class="lu-choice"><input type="radio" name="lu-asi-mode" value="points" ${c.asiMode === "points" ? "checked" : ""} /> ${t("Attribute erhöhen")}</label>
            <label class="lu-choice"><input type="radio" name="lu-asi-mode" value="feat" ${c.asiMode === "feat" ? "checked" : ""} /> ${t("Stattdessen ein Talent (falls der DM Talente erlaubt)")}</label>
          </div>
          ${c.asiMode === "points" ? `<div class="lu-asi">${rows}</div><p class="pc-hint">${t("Verteilt: {used} von {points}", { used, points: 2 })}</p>` : featHtml()}`;
      },
      valid: () => {
        if (c.asiMode === "feat") {
          if (!charOptions("feats").length) return c.feat.trim() ? true : t("Talent eintragen.");
          if (!featOption()) return t("Talent wählen.");
          const used = Object.values(c.featAsi).reduce((s, n) => s + n, 0);
          return used === featPoints() ? true : t("{points} des Talents verteilen.", { points: tn(featPoints(), "{n} Punkt", "{n} Punkte") });
        }
        const used = Object.values(c.asi).reduce((s, n) => s + n, 0);
        const room = ABILITIES.reduce((s, [k]) => s + (d.abilities[k] === null ? 0 : Math.max(0, ABILITY_MAX - d.abilities[k])), 0);
        return used === Math.min(2, room) ? true : t("Zwei Punkte verteilen.");
      },
    },
    {
      title: t("Trefferpunkte"),
      html: () => {
        const die = cls.hitDie;
        const g = hpGain();
        const { nx } = after();
        return `<p>${t("Neue Trefferpunkte: Trefferwürfel <b>W{die}</b> {sign} {con} (KON), mindestens 1.", { die, sign: nx.m.con >= 0 ? "+" : "−", con: Math.abs(nx.m.con) })}</p>
          <div class="lu-choices">
            <label class="lu-choice"><input type="radio" name="lu-hp" value="avg" ${c.hpMode === "avg" ? "checked" : ""} /> ${t("Durchschnitt nehmen: {n}", { n: die / 2 + 1 })}</label>
            <label class="lu-choice"><input type="radio" name="lu-hp" value="roll" ${c.hpMode === "roll" ? "checked" : ""} /> ${t("Würfeln:")}
              <input type="number" class="lu-roll" min="1" max="${die}" value="${c.hpRoll ?? ""}" placeholder="1–${die}" />
              <button type="button" class="ghost pc-btn" data-roll>🎲 ${diceDe(`d${die}`)}</button></label>
          </div>
          <p class="lu-hp-result">${g
            ? `<b>${t("+{n} TP", { n: g.total })}</b> (${g.roll} ${signed(g.con)} ${t("KON")}${g.retro ? `, ${t("{n} für die höhere KON auf {levels} früheren Stufen", { n: signed(g.retro), levels: x.lvl })}` : ""}${g.tough ? `, ${t("+1 Zwergische Unverwüstlichkeit")}` : ""}): ${t("Maximum {from} → {to}", { from: d.max_hp ?? 0, to: (d.max_hp ?? 0) + g.total })}`
            : "&nbsp;"}</p>`;
      },
      valid: () => (hpGain() ? true : c.hpMode === "roll" ? t("Gewürfelte Zahl (1–{n}) eintragen.", { n: cls.hitDie }) : t("Durchschnitt oder Würfeln wählen.")),
    },
    hasSpellStep && {
      title: t("Zauber"),
      html: () => {
        const s = spellNeeds();
        const group = (title, pool, set, need, attr) => {
          if (!need) return "";
          const byLevel = {};
          for (const sp of pool) (byLevel[sp.level_int] = byLevel[sp.level_int] || []).push(sp);
          return `<p><b>${title}: ${t("{n} von {max}", { n: set.size, max: need })}</b></p><div class="lu-spells">${Object.entries(byLevel)
            .map(([l, list]) => `<div class="pc-spell-level-label">${spellGroupLabel(Number(l))}</div>${list
              .map((sp) => `<label class="lu-choice"><input type="checkbox" ${attr}="${sp.id}" ${set.has(String(sp.id)) ? "checked" : ""} ${!set.has(String(sp.id)) && set.size >= need ? "disabled" : ""} />
                <span class="cs-info-link" ${infoAttr(`spell:${sp.id}:${sp.name}`)}>${esc(sp.name)}</span></label>`)
              .join("")}`)
            .join("")}</div>`;
        };
        const prepared = s.nx.spell.prepared !== null && !isSpellbook(d)
          ? `<p class="pc-hint">${t("Vorbereitete Zauber: ab jetzt {n} pro Tag, ausgewählt nach einer langen Rast.", { n: s.nx.spell.prepared })}</p>` : "";
        return `${group(t("Neue Zaubertricks"), s.cantripPool, c.cantrips, s.cantrips, "data-cantrip")}
          ${group(isSpellbook(d) ? t("Neue Zauber für das Zauberbuch") : t("Neue Zauber"), s.spellPool, c.spells, s.spells, "data-spell")}
          ${prepared}
          ${s.short ? `<p class="pc-warn">${t("Die Zauberliste der Bibliothek hat weniger Zauber dieser Klasse, als jetzt gewählt werden dürften.")}</p>` : ""}`;
      },
      valid: () => {
        const s = spellNeeds();
        return c.cantrips.size === s.cantrips && c.spells.size === s.spells ? true : t("Alle neuen Zauber wählen.");
      },
    },
    {
      title: t("Abschluss"),
      html: () => {
        const g = hpGain();
        const items = [
          t("Stufe {from} → <b>{to}</b>", { from: x.lvl, to: lvl }),
          t("Trefferpunkte +{n}: Maximum {from} → {to}, die momentanen steigen mit", { n: g.total, from: d.max_hp ?? 0, to: (d.max_hp ?? 0) + g.total }),
          c.sub && t("Unterklasse: {name}", { name: esc(optName(c.sub) || c.sub.name) }),
          asiAt && c.asiMode === "points" && t("Attribute: {list}", { list: Object.entries(c.asi).map(([k, n]) => `${ABILITY_SHORT[k]} +${n}`).join(", ") }),
          asiAt && c.asiMode === "feat" && `${t("Talent: {name}", { name: esc(featOption() ? optionLabel(featOption()) : c.feat) })}${
            featOption() && Object.keys(c.featAsi).length ? ` (${Object.entries(c.featAsi).map(([k, n]) => `${ABILITY_SHORT[k]} +${n}`).join(", ")})` : ""}`,
          c.cantrips.size && t("Zaubertricks: {list}", { list: [...c.cantrips].map((id) => esc(findSpell({ id }).name)).join(", ") }),
          c.spells.size && t("Zauber: {list}", { list: [...c.spells].map((id) => esc(findSpell({ id }).name)).join(", ") }),
          ...subSummary(),
        ].filter(Boolean);
        return `<ul class="pc-info-list">${items.map((i) => `<li>${i}</li>`).join("")}</ul><p class="pc-hint">${t("„Abschliessen“ speichert das Charakterblatt.")}</p>`;
      },
      valid: () => true,
    },
  ].filter(Boolean);
  // Steps with show() come and go with earlier choices (the subclass picked at this level).
  const steps = () => allSteps.filter((s) => !s.show || s.show());

  let dlg = document.getElementById("cs-levelup");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "cs-levelup";
    dlg.className = "cs-popup lu";
    document.body.appendChild(dlg);
  }
  let i = 0;
  let busy = false;

  const draw = () => {
    const list = steps();
    const step = list[i];
    const ok = step.valid();
    dlg.innerHTML = `
      <div class="cs-popup-body">
        <button type="button" class="cs-popup-close" aria-label="${t("Abbrechen")}">✕</button>
        <h3>${t("Stufenaufstieg auf Stufe {n}", { n: lvl })}</h3>
        <ol class="lu-steps">${list.map((s, n) => `<li class="${n === i ? "now" : n < i ? "done" : ""}">${s.title}</li>`).join("")}</ol>
        <div class="lu-body">${step.html()}</div>
        <div class="lu-nav">
          <button type="button" class="ghost pc-btn" data-back ${i === 0 ? "disabled" : ""}>${t("Zurück")}</button>
          <span class="pc-hint lu-why">${ok === true ? "" : esc(ok)}</span>
          <button type="button" class="pc-btn lu-next" data-next ${ok === true && !busy ? "" : "disabled"}>${i === list.length - 1 ? t("Abschliessen") : t("Weiter")}</button>
        </div>
      </div>`;
  };
  // Typing only updates the button, so the input keeps its focus.
  const refreshNav = () => {
    const ok = steps()[i].valid();
    dlg.querySelector("[data-next]").disabled = ok !== true || busy;
    dlg.querySelector(".lu-why").textContent = ok === true ? "" : ok;
    const res = dlg.querySelector(".lu-hp-result");
    if (res) {
      const tmp = document.createElement("div");
      tmp.innerHTML = steps()[i].html();
      res.innerHTML = tmp.querySelector(".lu-hp-result").innerHTML;
    }
  };

  async function finish() {
    const { nd } = after();
    const g = hpGain();
    const sr = subResult();
    const sb = { ...(entity.stat_block || {}) };
    Object.assign(sb, {
      level: lvl,
      ability_base: nd.ability_base,
      ability_choice: nd.ability_choice,
      feats: nd.feats,
      race_ref: d.race_ref,
      background_ref: d.background_ref,
      subclass_ref: c.sub ? (c.sub.id ? c.sub : null) : d.subclass_ref,
      subclass: c.sub ? c.sub.name : d.subclass,
      spell_list: [
        ...d.spell_list.map((s, n) => (sr && sr.marked.has(n) ? { ...s, ...sr.marked.get(n) } : s)),
        ...[...c.cantrips, ...c.spells].map((id) => {
          const sp = findSpell({ id });
          return { id: sp.id, name: sp.name, level: sp.level_int, prepared: false };
        }),
        ...(sr ? sr.spells : []),
      ],
    });
    if (sr) {
      if (sr.profs.length) sb.proficiencies = [d.proficiencies || cls.profs || "", sr.profs.join(", ")].filter(Boolean).join("; ");
      sb.skill_prof = [...new Set([...d.skill_prof, ...sr.skills])];
      sb.skill_expertise = [...new Set([...d.skill_expertise, ...sr.expertise])];
      if (sr.lang) sb.languages = [d.languages, sr.lang].filter(Boolean).join(", ");
    }
    if (asiAt && c.asiMode === "feat" && !featOption() && c.feat.trim()) sb.features = [sb.features, t("Talent (Stufe {n}): {name}", { n: lvl, name: c.feat.trim() })].filter(Boolean).join("\n");
    // The body the sheet editor would send, so all derived values (AC, speed, passive perception) match.
    const tmp = document.createElement("div");
    tmp.innerHTML = pcSheetHtml({ ...entity, stat_block: sb, max_hp: (entity.max_hp ?? 0) + g.total }, true);
    const body = readPcSheet(tmp);
    body.hp_gain = g.total;
    busy = true;
    refreshNav();
    try {
      await save(body);
      dlg.close();
    } catch (e) {
      busy = false;
      refreshNav();
      dlg.querySelector(".lu-why").textContent = e && e.message ? e.message : t("Nicht gespeichert. Verbindung prüfen.");
    }
  }

  dlg.onclick = (e) => {
    if (e.target === dlg || e.target.closest(".cs-popup-close")) {
      if (i === 0 || confirm(t("Stufenaufstieg abbrechen? Die Auswahl geht verloren."))) dlg.close();
      return;
    }
    const info = e.target.closest("[data-info]");
    if (info) {
      e.preventDefault();
      if (info.dataset.info.startsWith("opt:")) openOptionInfo(info.dataset.info);
      else {
        const content = sheetInfoContent(info);
        if (content) showSheetPopup(...content);
      }
      return;
    }
    const btn = e.target.closest("button");
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute("data-next")) {
      if (i === steps().length - 1) return finish();
      i++;
    } else if (btn.hasAttribute("data-back")) i--;
    else if (btn.dataset.featAsi) {
      const k = btn.dataset.featAsi;
      c.featAsi[k] = Math.max(0, (c.featAsi[k] || 0) + Number(btn.dataset.step));
      if (!c.featAsi[k]) delete c.featAsi[k];
    } else if (btn.dataset.asi) {
      const k = btn.dataset.asi;
      c.asi[k] = Math.max(0, (c.asi[k] || 0) + Number(btn.dataset.step));
      if (!c.asi[k]) delete c.asi[k];
    } else if (btn.hasAttribute("data-roll")) {
      c.hpMode = "roll";
      c.hpRoll = 1 + Math.floor(Math.random() * cls.hitDie);
    } else return;
    draw();
  };
  dlg.onchange = (e) => {
    const t = e.target;
    if (t.name === "lu-sub") {
      const o = subList.find((s) => String(s.id) === t.value);
      c.sub = optionRef(o);
    } else if (t.dataset.fixed) {
      if (t.checked) c.off.delete(t.dataset.fixed);
      else c.off.add(t.dataset.fixed);
    } else if (t.dataset.skip) {
      if (t.checked) c.skip.add(t.dataset.skip);
      else c.skip.delete(t.dataset.skip);
    } else if (t.dataset.pick) {
      const set = (c.picks[t.dataset.pick] = c.picks[t.dataset.pick] || new Set());
      if (t.checked) set.add(t.value);
      else set.delete(t.value);
    } else if (t.name === "lu-asi-mode") c.asiMode = t.value;
    else if (t.classList.contains("lu-feat-pick")) {
      c.featId = t.value;
      c.featAsi = {};
    }
    else if (t.name === "lu-hp") c.hpMode = t.value;
    else if (t.dataset.cantrip || t.dataset.spell) {
      const set = t.dataset.cantrip ? c.cantrips : c.spells;
      const id = t.dataset.cantrip || t.dataset.spell;
      if (t.checked) set.add(id);
      else set.delete(id);
    } else return;
    draw();
  };
  dlg.oninput = (e) => {
    const t = e.target;
    if (t.classList.contains("lu-feat")) c.feat = t.value;
    else if (t.classList.contains("lu-lang")) c.lang = t.value;
    else if (t.classList.contains("lu-sub-text")) c.sub = t.value.trim() ? { name: t.value.trim() } : undefined;
    else if (t.classList.contains("lu-roll")) {
      const v = parseInt(t.value, 10);
      c.hpMode = "roll";
      c.hpRoll = v >= 1 && v <= cls.hitDie ? v : null;
      const radio = dlg.querySelector('input[name="lu-hp"][value="roll"]');
      if (radio) radio.checked = true;
    } else return;
    refreshNav();
  };

  draw();
  dlg.showModal();
}
