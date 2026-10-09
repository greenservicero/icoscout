"use strict";
/* =====================================================================
   Cruscotto datalogger FV — versione per telefono
   GenEthic Power Systems

   Si collega in MQTT-over-WebSocket allo stesso broker usato dalla
   scheda ESP32 e mostra l'ultimo campione ricevuto. Nessuno storico:
   i dati vivono finche' la pagina resta aperta, esattamente come nel
   cruscotto da PC.

   La pagina si adatta da sola al numero di fasi: se nel payload non
   compaiono v_l2 / v_l3 (contatore monofase, per esempio un Eastron
   SDM230) passa in modalita' monofase e nasconde cio' che non esiste.
   Stesso trattamento per i THD, che l'SDM230 non misura.
   ===================================================================== */
(function () {

/* ---------- configurazione memorizzata ---------- */
var CHIAVE = "cruscottofv.cfg";
var CFG_DEF = {   /* copia ONLINE (GitHub Pages): predefinito il broker EMQX su internet */
  proto: "wss",
  host:  "wc911c25.ala.eu-central-1.emqxsl.com",
  porta: "8084",
  topic: "icopower/impianto01/analizzatore",
  settore: "",
  user:  "icoscout01",
  pass:  "",
  sola:  ""      /* "1" = sola lettura (colleghi): il settore non si puo' cambiare */
};
var cfg = leggiCfg();

/* 08/10/2026: indirizzo per i colleghi in sola lettura, es.
   https://greenservicero.github.io/icoscout/?lettura=Piercarlo
   Imposta l'utente, attiva la sola lettura e lo ricorda sul telefono;
   poi l'indirizzo si ripulisce, cosi' l'icona sulla schermata Home
   apre l'app normale con queste impostazioni gia' salvate. */
(function () {
  try {
    var q = new URLSearchParams(location.search);
    var chi = q.get("lettura");
    if (chi) {
      if (cfg.user !== chi) cfg.pass = "";
      cfg.user = chi; cfg.sola = "1"; salvaCfg();
      history.replaceState(null, "", location.pathname);
    } else if (q.has("completo")) {      /* torna alla versione con comandi */
      cfg.user = CFG_DEF.user; cfg.pass = ""; cfg.sola = ""; salvaCfg();
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {}
})();

function leggiCfg() {
  var c = {};
  for (var k in CFG_DEF) c[k] = CFG_DEF[k];
  try {
    var s = localStorage.getItem(CHIAVE);
    if (s) {
      var o = JSON.parse(s);
      for (var j in CFG_DEF) if (typeof o[j] === "string") c[j] = o[j];
      /* 02/10/2026: il topic vecchio salvato sul telefono passa da solo al nuovo */
      if (c.topic === "genethic/impianto01/analizzatore") c.topic = CFG_DEF.topic;
    }
  } catch (e) {}
  return c;
}
function salvaCfg() { try { localStorage.setItem(CHIAVE, JSON.stringify(cfg)); } catch (e) {} }

/* ---------- stato ---------- */
var MAX = 2000;               /* campioni tenuti in memoria: oltre un'ora a 2 s */
var dati = [];
var client = null;
var ricevuti = 0;
var ultimoArrivo = 0;
var vista = "tensione";
var finestraSec = 300;
var trifase = true;           /* aggiornato dal primo campione */
var conThd = true;
var gradiniVde = [];          /* tagli di tensione presenti nel payload: [8, 12, 16] */
var pointerGiu = false;       /* mentre il dito e' sul grafico non si ridisegna */

var S1 = "var(--series-1)", S2 = "var(--series-2)", S3 = "var(--series-3)";

/* ---------- utilita' ---------- */
function $(id) { return document.getElementById(id); }
function num(v, dec) {
  if (v === null || v === undefined || !isFinite(v)) return "—";
  return v.toLocaleString("it-IT", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function ora(ms) {
  var d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0") + ":" +
         String(d.getSeconds()).padStart(2, "0");
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c];
  });
}
function c_e(c, k) { return c && typeof c[k] === "number" && isFinite(c[k]); }

/* Grandezze che esistono solo a certe condizioni.
   cos phi = P/S: senza corrente non e' definito e il contatore scrive 0.
   Mostrarlo come 0 dove "sotto 0,90" vuol dire penale e' fuorviante: si omette.
   Squilibrio e tensione media: hanno senso solo sulle fasi davvero alimentate.
   Su un banco con la sola L1 viva, max-min darebbe l'intera tensione di rete. */
var S_MINIMA_VA = 10, V_FASE_VIVA = 50;
function cosphiValido(c) {
  return c_e(c, "cosphi") && c_e(c, "s_tot_va") && Math.abs(c.s_tot_va) >= S_MINIMA_VA;
}
/* THD di corrente: sotto questa corrente di fase il contatore calcola la
   distorsione su un segnale minimo e restituisce numeri grandi e casuali.
   Tipico della misura da presa, dove passa solo la corrente del kit. */
var I_MIN_THD = 0.5;
/* 06/10/2026 (decisione di Ferdinando): BETA FISSO DI SETTORE = mediana
   del beta misurato con i PEL di ICO Power (90 registrazioni). Non si stima
   piu' dal THDv. Stessa tabella del firmware e del cruscotto PC. Le chiavi
   vecchie (motel, plastica, meccanica) servono solo a leggere preferenze
   salvate prima del 06/10. */
var BETA_GENERICO = 0.14;
var SETTORI = {
  /* 09/10/2026 (decisione di Ferdinando): mediane del file Calcolo_VDE_per_sito
     dell'08/10 (172 punti PEL, 149 inclusi). Stessa tabella del firmware. */
  fastfood:     { nome: "Fast food",            beta: 0.06  },
  riposo:       { nome: "Case di riposo",       beta: 0.126 },
  hotel:        { nome: "Hotel",                beta: 0.132 },
  logistica:    { nome: "Logistica",            beta: 0.132 },
  supermercati: { nome: "Supermercati / GDO",   beta: 0.134 },
  commercio:    { nome: "Commercio non alimentare", beta: 0.158 },
  industria:    { nome: "Industria",            beta: 0.174 },
  freddo:       { nome: "Logistica del freddo", beta: 0.174 },
  uffici:       { nome: "Uffici",               beta: 0.187 }
};
var ALIAS_SETTORE = { motel: "hotel", plastica: "industria", meccanica: "industria" };
function chiaveSettore(k) { return ALIAS_SETTORE[k] || k; }
var FASI = ["l1", "l2", "l3"];
function thdVFasi(c) {
  return FASI.map(function (f, k) {
    return { f: "L" + (k + 1), v: c["thd_v_" + f] };
  }).filter(function (x) { return isFinite(x.v); });
}
function thdIValido(c, f) {
  return c_e(c, "thd_i_" + f) && c_e(c, "i_" + f) && Math.abs(c["i_" + f]) >= I_MIN_THD;
}
function thdIFasi(c) {
  return FASI.map(function (f, k) {
    return { f: "L" + (k + 1), v: thdIValido(c, f) ? c["thd_i_" + f] : NaN };
  }).filter(function (x) { return isFinite(x.v); });
}
/* Risparmio stimato VDE (dal 29/09/2026 sera): il firmware sceglie il taglio
   come la macchina ICO Power (gradino piu' grande che lascia l'uscita sopra
   l'obiettivo, di solito 216 V) e manda risp_pct, taglio_v, vout_obj.
   gradiniVde resta come segnale "c'e' il calcolo": [1] oppure []. */
function trovaGradini(c) { return c_e(c, "risp_pct") ? [1] : []; }
function vMedia(c) {
  var a = [c.v_l1, c.v_l2, c.v_l3].filter(function (v) { return isFinite(v) && v > V_FASE_VIVA; });
  return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN;
}
/* 06/10/2026: il 16 V entra OGNI VOLTA che c'e' margine (V media - 16 >=
   uscita obiettivo), senza la vecchia soglia dei 227 V. Come nel firmware. */
var GRADINI_V = [16, 12, 8];
function taglioMacchina(v, obj) {
  for (var i = 0; i < GRADINI_V.length; i++) if (v - GRADINI_V[i] >= obj) return GRADINI_V[i];
  return 0;
}
/* Firmware del 06/10/2026 in poi: beta fisso di settore gia' applicato */
function daFirmware(c) { return c.beta_fonte === "settore" && c_e(c, "risp_pct") && c_e(c, "taglio_v"); }
function stessoSettore(c, chiave) {
  return daFirmware(c) && chiaveSettore(c.settore === "generico" ? "" : c.settore) === chiave;
}
function betaSettore(c, chiave) {
  if (stessoSettore(c, chiave)) return c.beta;
  var s = SETTORI[chiave];
  return s ? s.beta : BETA_GENERICO;
}
function taglioRicalcolato(c) {
  if (daFirmware(c)) return c.taglio_v;
  var v = vMedia(c);
  return v >= 50 ? taglioMacchina(v, c_e(c, "vout_obj") ? c.vout_obj : 216) : NaN;
}
/* risparmio = 100 * alfa * u * (2 - u), u = taglio / V media,
   alfa = max(0, 1 - beta - u^x); bypass: 0 */
function rispSettore(c, chiave) {
  if (stessoSettore(c, chiave)) return c.risp_pct;
  var v = vMedia(c);
  if (!(v >= 50)) return NaN;
  var g = taglioRicalcolato(c);
  if (!(g > 0)) return 0;
  var x = c_e(c, "vde_x") ? c.vde_x : 0.45;
  var u = g / v, a = 1 - betaSettore(c, chiave) - Math.pow(u, x);
  if (a < 0) a = 0;
  return 100 * a * u * (2 - u);
}
function notaRisparmio(c) {
  var g = taglioRicalcolato(c);
  if (!isFinite(g)) return "tensione non disponibile";
  var obj = c_e(c, "vout_obj") ? c.vout_obj : 216;
  if (g === 0) return "bypass: tensione troppo vicina a " + obj + " V";
  return "taglio " + g + " V · uscita ≈ " + num(vMedia(c) - g, 0) + " V (min " + obj + ")";
}
function fasiVive(c) {
  return [c.v_l1, c.v_l2, c.v_l3].filter(function (v) {
    return isFinite(v) && v > V_FASE_VIVA; }).length;
}

/* Valori tondi per la scala verticale: passo della serie 1-2-5 per decade,
   cioe' 1, 2, 5, 10, 20, 50, 100... E' la regola che si usa da sempre sulla
   carta millimetrata, e resta la piu' leggibile anche su uno schermo piccolo. */
function tacche(lo, hi, quante) {
  var campo = hi - lo;
  if (!(campo > 0)) return [lo];
  var grezzo = campo / Math.max(quante, 2);
  var dec = Math.pow(10, Math.floor(Math.log(grezzo) / Math.LN10));
  var f = grezzo / dec;
  var passo = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * dec;
  var out = [], v = Math.ceil(lo / passo - 1e-9) * passo;
  for (var i = 0; i < 12 && v <= hi + 1e-9; i++) {
    /* lo zero calcolato per accumulo puo' uscire come -0 o come -1e-13, e
       verrebbe stampato "-0": si azzera prima di formattarlo */
    out.push(Math.abs(v) < passo * 1e-6 ? 0 : v);
    v += passo;
  }
  return out.length >= 2 ? out : [lo, hi];
}

/* ---------- barra di stato ---------- */
function setStato(classe, testo) {
  $("stato").className = "pill " + classe;
  $("statoTxt").textContent = testo;
}
function nota(testo, errore) {
  var n = $("nota");
  n.innerHTML = testo;
  n.className = errore ? "nota err" : "nota";
}

/* ---------- connessione ---------- */
function collega() {
  if (client) { try { client.end(true); } catch (e) {} client = null; }

  if (!cfg.host) {
    setStato("off", "Da configurare");
    nota("Nessun broker impostato. Apri le impostazioni con l'ingranaggio in alto a destra.");
    return;
  }

  // 08/10/2026: broker su internet (EMQX) vuole il percorso /mqtt sul WebSocket cifrato
  var url = cfg.proto + "://" + cfg.host + ":" + (cfg.porta || "9001") + (cfg.proto === "wss" ? "/mqtt" : "");
  setStato("wait", "Connessione");
  nota("Collegamento a <code>" + esc(url) + "</code> in corso…");

  var opz = {
    clientId: "telefono-" + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 4000,
    connectTimeout: 8000,
    clean: true
  };
  if (cfg.user) { opz.username = cfg.user; opz.password = cfg.pass; }

  try {
    client = mqtt.connect(url, opz);
  } catch (e) {
    setStato("off", "Errore");
    nota("Impossibile aprire la connessione: " + esc(e.message), true);
    return;
  }

  client.on("connect", function () {
    setStato("on", "Collegato");
    client.subscribe(cfg.topic, function (err) {
      if (err) { nota("Iscrizione al topic fallita: " + esc(String(err)), true); return; }
      nota("In ascolto su <code>" + esc(cfg.topic) + "</code>. Un campione ogni 2 secondi.");
    });
  });

  client.on("reconnect", function () { setStato("wait", "Riconnessione"); });
  client.on("offline",   function () { setStato("off", "Non collegato"); });
  client.on("close",     function () { if ($("stato").className.indexOf("on") >= 0) setStato("off", "Chiusa"); });

  client.on("error", function (err) {
    setStato("off", "Errore");
    nota("Errore di connessione: " + esc(String((err && err.message) || err)) +
         ". Controlla che il broker sia avviato, che il listener WebSocket sulla porta " +
         esc(cfg.porta) + " sia attivo e che il firewall del PC la lasci passare.", true);
  });

  client.on("message", function (_topic, payload) {
    var c;
    try { c = JSON.parse(payload.toString()); }
    catch (e) { return; }                   /* payload non JSON: ignorato */
    c._t = (typeof c.ts === "number" && c.ts > 1e9) ? c.ts * 1000 : Date.now();
    /* Inserimento in ordine di tempo, non di arrivo (29/09/2026). Quando la
       scheda si ricollega al broker ripubblica i campioni rimasti in coda
       sulla flash, che hanno un orario PIU' VECCHIO di quelli gia' arrivati:
       accodati in fondo facevano tornare indietro le linee del grafico e
       uscire dall'asse. Un doppione dello stesso istante si scarta. */
    var k = dati.length;
    while (k > 0 && dati[k - 1]._t > c._t) k--;
    if (k > 0 && dati[k - 1]._t === c._t) return;
    dati.splice(k, 0, c);
    if (dati.length > MAX) dati.splice(0, dati.length - MAX);
    ricevuti++;
    ultimoArrivo = Date.now();

    if (ricevuti === 1) {
      trifase = c_e(c, "v_l2") || c_e(c, "v_l3");
      conThd  = c_e(c, "thd_i_l1") || c_e(c, "thd_v_l1");
      gradiniVde = trovaGradini(c);
      $("sottotitolo").textContent =
        (c.id ? c.id + " · " : "") + (trifase ? "trifase" : "monofase");
      costruisciChips();
    }
    disegna();
  });
}

/* ---------- finestra temporale ---------- */
function finestra() {
  if (!dati.length) return [];
  var limite = dati[dati.length - 1]._t - finestraSec * 1000;
  var i = dati.length - 1;
  while (i > 0 && dati[i - 1]._t >= limite) i--;
  return dati.slice(i);
}

/* ---------- riquadro principale ---------- */
function riquadroPrincipale() {
  if (!dati.length) return;
  var c = dati[dati.length - 1];
  var kw = c_e(c, "p_tot_w") ? c.p_tot_w / 1000 : NaN;

  $("heroV").innerHTML = num(kw, 2) + '<span class="u">kW</span>';

  var pezzi = [];
  if (c_e(c, "s_tot_va"))  pezzi.push(num(c.s_tot_va / 1000, 2) + " kVA apparente");
  if (c_e(c, "q_tot_var")) pezzi.push(num(c.q_tot_var, 0) + " var reattiva");
  $("heroN").textContent = pezzi.join(" · ") || "—";

  var v = $("heroVerso");
  if (isFinite(kw)) {
    v.hidden = false;
    if (kw < 0) { v.className = "verso imm"; v.textContent = "Immissione in rete"; }
    else        { v.className = "verso";     v.textContent = "Prelievo dalla rete"; }
  } else {
    v.hidden = true;
  }
}

/* ---------- riquadri secondari ---------- */
function riquadri() {
  var c = dati.length ? dati[dati.length - 1] : null;

  function med(c) {
    if (!trifase) return c_e(c, "v_l1") ? c.v_l1 : NaN;
    /* solo le fasi vive: una fase spenta abbasserebbe la media di un terzo */
    var a = [c.v_l1, c.v_l2, c.v_l3].filter(function (v) {
      return isFinite(v) && v > V_FASE_VIVA; });
    return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN;
  }
  function squilibrio(c) {
    var a = [c.v_l1, c.v_l2, c.v_l3].filter(isFinite);
    return a.length > 1 ? Math.max.apply(null, a) - Math.min.apply(null, a) : NaN;
  }
  function corrMax(c) {
    var a = [c.i_l1, c.i_l2, c.i_l3].filter(isFinite);
    return a.length ? Math.max.apply(null, a) : NaN;
  }

  var T = [
    { k: "Fattore di potenza", u: "",
      f: function (c) { return cosphiValido(c) ? num(c.cosphi, 3) : "—"; },
      n: function (c) { return cosphiValido(c)
            ? (Math.abs(c.cosphi) >= 0.9 ? "sopra la soglia 0,90" : "sotto 0,90 — penale")
              + (c.cosphi < 0 ? " (in immissione)" : "")
            : "carico troppo basso"; },
      // soglia sul valore assoluto: il segno e' il verso, non la qualita'
      cl: function (c) { return !cosphiValido(c) ? "" : (Math.abs(c.cosphi) >= 0.9 ? "ok" : "bad"); } },

    { k: trifase ? "Tensione media" : "Tensione", u: "V",
      f: function (c) { return num(med(c), 1); },
      n: function (c) {
           if (!trifase) return "fase singola";
           var k = fasiVive(c);
           if (k === 0) return "nessuna fase alimentata";
           if (k < 3)   return k === 1 ? "una sola fase alimentata"
                                       : "solo " + k + " fasi alimentate";
           return "squilibrio " + num(squilibrio(c), 1) + " V"; } },

    { k: trifase ? "Corrente max" : "Corrente", u: "A",
      f: function (c) { return num(trifase ? corrMax(c) : c.i_l1, 2); },
      n: function () { return trifase ? "la più alta delle tre fasi" : "fase singola"; } },

    { k: "Frequenza", u: "Hz",
      f: function (c) { return num(c.freq_hz, 2); },
      n: function () { return "nominale 50,00"; } },

    conThd
      ? { k: "THD tensione", u: "%",
          /* il valore e' la fase peggiore; il limite EN 50160 e' 8 % */
          f: function (c) { var a = thdVFasi(c);
               return a.length ? num(Math.max.apply(null, a.map(function (x) { return x.v; })), 1) : "—"; },
          n: function (c) { var a = thdVFasi(c);
               if (!a.length) return "—";
               if (a.length === 1) return "fase singola · limite 8 %";
               return a.map(function (x) { return x.f + " " + num(x.v, 1); }).join(" · "); },
          cl: function (c) { var a = thdVFasi(c);
               return a.length && Math.max.apply(null, a.map(function (x) { return x.v; })) > 8 ? "bad" : ""; } }
      : { k: "THD tensione", u: "",
          f: function () { return "—"; },
          n: function () { return "non misurato dal contatore"; } },

    gradiniVde.length
      ? { k: "Risparmio indicativo VDE", u: "%",
          f: function (c) { return num(rispSettore(c, cfg.settore), 1); },
          /* 05/10/2026: con THDv >= 5 % (fase peggiore) la norma VDE non si applica */
          cl: function (c) { var a = thdVFasi(c);
               return a.length && Math.max.apply(null, a.map(function (x) { return x.v; })) >= 5 ? "bad" : ""; },
          n: function (c) { var a = thdVFasi(c);
               /* 06/10/2026: con THDv >= 5 % si avvisa che la norma VDE non si applica */
               var t = a.length ? Math.max.apply(null, a.map(function (x) { return x.v; })) : NaN;
               return (t >= 5 ? "THDv " + num(t, 1) + " % ≥ 5 %: norma non applicabile · " : "") + notaRisparmio(c); } }
      : { k: "Risparmio indicativo VDE", u: "",
          f: function () { return "—"; },
          n: function () { return "firmware senza calcolo VDE"; } },

    gradiniVde.length
      ? { k: "Coefficienti VDE", u: "",
          /* 02/10/2026: beta e x dal firmware; THDv < 5 % = condizione della norma */
          f: function (c) { var b = betaSettore(c, cfg.settore); return isFinite(b) ? "β " + num(b, 3) : "—"; },
          n: function (c) {
               var s = SETTORI[cfg.settore];
               return (s ? s.nome : "Generico") + ": β fisso (mediana PEL) · x " +
                      num(c_e(c, "vde_x") ? c.vde_x : 0.45, 2); } }
      : null,

    { k: "Energia prelevata", u: "kWh",
      f: function (c) { return num(c.e_imp_kwh, 1); },
      n: function (c) { return c_e(c, "e_exp_kwh") ? "immessa " + num(c.e_exp_kwh, 1) + " kWh" : "—"; } }
  ];

  /* 03/10/2026 (decisione di Ferdinando), come sul cruscotto PC: nascosti
     Fattore di potenza, Corrente max ed Energia prelevata (e il riquadro
     grande della Potenza attiva); gli altri in quest'ordine. */
  var ORDINE_TILE = ["Tensione media", "Tensione", "Frequenza", "THD tensione",
                     "Risparmio indicativo VDE", "Coefficienti VDE"];
  T = T.filter(Boolean);
  T = ORDINE_TILE.map(function (k) {
    return T.filter(function (d) { return d.k === k; })[0];
  }).filter(Boolean);

  $("tiles").innerHTML = T.filter(Boolean).map(function (d) {
    if (!c) {
      return '<div class="tile"><div class="k">' + esc(d.k) + '</div>' +
             '<div class="v">—</div><div class="n">in attesa</div></div>';
    }
    var testo = "—", nt = "", cls = "";
    try { testo = d.f(c); } catch (e) {}
    try { nt = d.n(c); } catch (e) {}
    try { cls = d.cl ? d.cl(c) : ""; } catch (e) {}
    return '<div class="tile"><div class="k">' + esc(d.k) + '</div>' +
           '<div class="v ' + cls + '">' + testo + (d.u && testo !== "—" ? '<span class="u">' + d.u + '</span>' : '') + '</div>' +
           '<div class="n">' + esc(nt) + '</div></div>';
  }).join("");
}

/* ---------- definizione delle viste del grafico ---------- */
function viste() {
  var V = {
    potenza: {
      nome: "Potenza",
      /* nessuna unita' comune: le tre serie sono W, VA e var, e l'unita'
         sta gia' nel nome di ciascuna. Metterne una sola nel riquadro del
         mirino farebbe leggere "4.797 W" su una potenza apparente. */
      dec: 0, u: "", zero: true,
      serie: [
        { nome: "Attiva P (W)",     c: S1, v: function (x) { return x.p_tot_w; } },
        { nome: "Apparente S (VA)", c: S2, v: function (x) { return x.s_tot_va; } },
        { nome: "Reattiva Q (var)", c: S3, v: function (x) { return x.q_tot_var; } }
      ],
      aria: "Andamento delle potenze attiva, apparente e reattiva"
    },
    tensione: {
      nome: "Tensione",
      dec: 1, u: "V",
      serie: trifase
        ? [ { nome: "L1", c: S1, v: function (x) { return x.v_l1; } },
            { nome: "L2", c: S2, v: function (x) { return x.v_l2; } },
            { nome: "L3", c: S3, v: function (x) { return x.v_l3; } } ]
        : [ { nome: "Tensione", c: S1, v: function (x) { return x.v_l1; } } ],
      aria: "Andamento della tensione"
    },
    corrente: {
      nome: "Corrente",
      dec: 2, u: "A", floor: 0,
      serie: trifase
        ? [ { nome: "L1", c: S1, v: function (x) { return x.i_l1; } },
            { nome: "L2", c: S2, v: function (x) { return x.i_l2; } },
            { nome: "L3", c: S3, v: function (x) { return x.i_l3; } } ]
        : [ { nome: "Corrente", c: S1, v: function (x) { return x.i_l1; } } ],
      aria: "Andamento della corrente"
    },
    cosphi: {
      nome: "cos φ",
      dec: 3, u: "", floor: 0.80, ceil: 1,
      serie: [ { nome: "cos φ", c: S1,
                 v: function (x) { return cosphiValido(x) ? x.cosphi : NaN; } } ],
      aria: "Andamento del fattore di potenza"
    }
  };
  var COL = [S1, S2, S3];
  if (conThd) {
    V.thdv = {
      nome: "THD V",
      dec: 1, u: "%", floor: 0,
      serie: (trifase ? FASI : ["l1"]).map(function (f, k) {
        return { nome: trifase ? "L" + (k + 1) : "THD tensione", c: COL[k],
                 v: function (x) { return x["thd_v_" + f]; } };
      }),
      aria: "Andamento della distorsione armonica di tensione"
    };
    V.thdi = {
      nome: "THD I",
      dec: 1, u: "%", floor: 0,
      /* i punti con corrente troppo bassa si omettono, non si disegnano a 0 */
      serie: (trifase ? FASI : ["l1"]).map(function (f, k) {
        return { nome: trifase ? "L" + (k + 1) : "THD corrente", c: COL[k],
                 v: function (x) { return thdIValido(x, f) ? x["thd_i_" + f] : NaN; } };
      }),
      aria: "Andamento della distorsione armonica di corrente"
    };
  }
  if (gradiniVde.length) {
    V.risparmio = {
      nome: "Risparmio",
      dec: 2, u: "%", floor: 0,
      serie: [ { nome: "Risparmio indicativo VDE (%)", c: S1, v: function (x) { return rispSettore(x, cfg.settore); } } ],
      aria: "Risparmio indicativo secondo la norma VDE, con il taglio scelto dalla macchina e un carico di riferimento"
    };
  }
  /* 02/10/2026: stesso ordine dei grafici del cruscotto PC */
  var ORD = ["tensione", "risparmio", "thdv", "thdi", "potenza", "cosphi", "corrente"], R = {};
  ORD.forEach(function (k) { if (V[k]) R[k] = V[k]; });
  /* 03/10/2026 (decisione di Ferdinando), come sul cruscotto PC: nascoste le
     viste Potenza, cos phi e Corrente. Per rimetterle toglierle da NASCOSTE. */
  var NASCOSTE = ["potenza", "cosphi", "corrente", "thdi"];   /* 06/10/2026: anche THD I */
  Object.keys(V).forEach(function (k) { if (!R[k] && NASCOSTE.indexOf(k) < 0) R[k] = V[k]; });
  NASCOSTE.forEach(function (k) { delete R[k]; });
  return R;
}

function costruisciChips() {
  var V = viste();
  if (!V[vista]) vista = "tensione";
  $("chips").innerHTML = Object.keys(V).map(function (k) {
    return '<button class="chip" role="tab" data-v="' + k + '" aria-selected="' +
           (k === vista) + '">' + esc(V[k].nome) + "</button>";
  }).join("");
}

/* =====================================================================
   Grafico a linee, una vista alla volta.
   Marcatori sottili, griglia recessiva, nessun pallino sui singoli
   punti. L'identita' delle serie non e' affidata al solo colore: c'e'
   la legenda e c'e' l'etichetta diretta all'estremita' della linea.
   ===================================================================== */
function grafico(campioni) {
  var host = $("plot");
  var V = viste()[vista];
  var serie = V.serie;

  $("legenda").innerHTML = serie.map(function (s) {
    return '<span class="lg"><span class="sw" style="background:' + s.c + '"></span>' + esc(s.nome) + "</span>";
  }).join("");

  if (campioni.length < 2) {
    host.innerHTML = '<div class="empty">In attesa di dati…</div>';
    return;
  }

  var W = Math.max(host.clientWidth || 340, 260), H = 208;
  var mL = 42, mR = 48, mT = 10, mB = 20;
  var pw = W - mL - mR, ph = H - mT - mB;

  var t0 = campioni[0]._t, t1 = campioni[campioni.length - 1]._t;
  if (t1 - t0 < 1000) t1 = t0 + 1000;

  var lo = Infinity, hi = -Infinity;
  campioni.forEach(function (c) {
    serie.forEach(function (s) {
      var v = s.v(c);
      if (isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    });
  });
  if (!isFinite(lo)) { host.innerHTML = '<div class="empty">Nessun dato valido per questa vista</div>'; return; }
  if (hi - lo < 1e-9) hi = lo + (Math.abs(lo) * 0.05 || 1);
  var pad = (hi - lo) * 0.14; lo -= pad; hi += pad;
  /* limiti fisici applicati DOPO il margine: altrimenti l'asse scenderebbe
     sotto valori che non possono esistere (una corrente negativa, un cos phi
     sopra 1) e il grafico racconterebbe una cosa falsa */
  if (V.floor !== undefined && lo < V.floor) lo = V.floor;
  if (V.ceil  !== undefined && hi > V.ceil)  hi = V.ceil;
  if (hi - lo < 1e-9) hi = lo + 1;

  function X(t) { return mL + (t - t0) / (t1 - t0) * pw; }
  function Y(v) { return mT + (1 - (v - lo) / (hi - lo)) * ph; }

  var g = [];
  /* Scala verticale su valori tondi. Dividere l'intervallo in tre parti uguali
     e' piu' semplice, ma produce etichette come 9.863 / 7.065 / 4.267 che su
     uno schermo piccolo si leggono male e non aiutano a stimare nulla. */
  tacche(lo, hi, 4).forEach(function (v) {
    var y = Y(v);
    g.push('<line x1="' + mL + '" y1="' + y.toFixed(1) + '" x2="' + (mL + pw) + '" y2="' + y.toFixed(1) +
           '" stroke="var(--grid)" stroke-width="1"/>');
    g.push('<text x="' + (mL - 7) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" ' +
           'fill="var(--text-muted)" font-variant-numeric="tabular-nums">' + num(v, V.dec) + "</text>");
  });
  /* riferimento dello zero: con la potenza che cambia segno, senza questa
     riga non si capirebbe dove finisce il prelievo e comincia l'immissione */
  if (V.zero && lo < 0 && hi > 0) {
    var y0 = Y(0);
    g.push('<line x1="' + mL + '" y1="' + y0.toFixed(1) + '" x2="' + (mL + pw) + '" y2="' + y0.toFixed(1) +
           '" stroke="var(--border-strong)" stroke-width="1.2"/>');
  }

  [0, 0.5, 1].forEach(function (f) {
    var t = t0 + (t1 - t0) * f;
    g.push('<text x="' + X(t).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="' +
           (f === 0 ? "start" : f === 1 ? "end" : "middle") + '" font-size="10.5" fill="var(--text-muted)" ' +
           'font-variant-numeric="tabular-nums">' + ora(t) + "</text>");
  });

  serie.forEach(function (s) {
    var d = "", giu = true;
    campioni.forEach(function (c) {
      var v = s.v(c);
      if (!isFinite(v)) { giu = true; return; }
      d += (giu ? "M" : "L") + X(c._t).toFixed(1) + " " + Y(v).toFixed(1) + " ";
      giu = false;
    });
    g.push('<path d="' + d + '" fill="none" stroke="' + s.c + '" stroke-width="2" ' +
           'stroke-linejoin="round" stroke-linecap="round"/>');
  });

  var ult = campioni[campioni.length - 1];
  var usate = [];
  serie.forEach(function (s) {
    var vv = s.v(ult);
    if (!isFinite(vv)) return;
    var y = Y(vv);
    while (usate.some(function (u) { return Math.abs(u - y) < 12; })) y += 12;
    usate.push(y);
    g.push('<circle cx="' + X(ult._t).toFixed(1) + '" cy="' + Y(vv).toFixed(1) + '" r="3.5" fill="' + s.c +
           '" stroke="var(--surface-1)" stroke-width="2"/>');
    g.push('<text x="' + (mL + pw + 5) + '" y="' + (y + 3.5).toFixed(1) + '" font-size="11" font-weight="600" ' +
           'fill="var(--text-secondary)" font-variant-numeric="tabular-nums">' + num(vv, V.dec) + "</text>");
  });

  g.push('<line class="cross" x1="0" y1="' + mT + '" x2="0" y2="' + (mT + ph) +
         '" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>');

  host.innerHTML = '<svg class="plot" viewBox="0 0 ' + W + " " + H + '" height="' + H +
                   '" role="img" aria-label="' + esc(V.aria) + '">' + g.join("") + "</svg>";

  /* ---- mirino a dito ---- */
  var card  = host.closest(".card");
  var tip   = card.querySelector(".tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "tip"; card.appendChild(tip); }
  var svg   = host.querySelector("svg");
  var cross = svg.querySelector(".cross");

  function muovi(ev) {
    var r = svg.getBoundingClientRect();
    var px = (ev.clientX - r.left) / r.width * W;
    if (px < mL || px > mL + pw) { tip.style.opacity = 0; cross.setAttribute("opacity", 0); return; }
    var t = t0 + (px - mL) / pw * (t1 - t0);
    var best = campioni[0], bd = Infinity;
    campioni.forEach(function (c) { var d2 = Math.abs(c._t - t); if (d2 < bd) { bd = d2; best = c; } });
    var bx = X(best._t);
    cross.setAttribute("x1", bx); cross.setAttribute("x2", bx); cross.setAttribute("opacity", 1);
    tip.innerHTML = '<div class="th">' + ora(best._t) + "</div>" +
      serie.map(function (s) {
        return '<div class="tr"><span class="sw" style="background:' + s.c + '"></span>' +
               esc(s.nome) + " <b>" + num(s.v(best), V.dec) + (V.u ? " " + V.u : "") + "</b></div>";
      }).join("");
    var cr = card.getBoundingClientRect();
    var left = ev.clientX - cr.left + 14;
    if (left + tip.offsetWidth > cr.width - 8) left = ev.clientX - cr.left - tip.offsetWidth - 14;
    tip.style.left = Math.max(6, left) + "px";
    /* sopra il dito, altrimenti la mano copre proprio il riquadro */
    tip.style.top  = Math.max(4, ev.clientY - cr.top - tip.offsetHeight - 16) + "px";
    tip.style.opacity = 1;
  }

  svg.addEventListener("pointerdown", function (ev) {
    pointerGiu = true;
    try { svg.setPointerCapture(ev.pointerId); } catch (e) {}
    muovi(ev);
  });
  svg.addEventListener("pointermove", function (ev) { if (pointerGiu || ev.pointerType === "mouse") muovi(ev); });
  function su() {
    pointerGiu = false;
    tip.style.opacity = 0;
    cross.setAttribute("opacity", 0);
  }
  svg.addEventListener("pointerup", su);
  svg.addEventListener("pointercancel", su);
  svg.addEventListener("pointerleave", function (ev) { if (ev.pointerType === "mouse") su(); });
}

/* ---------- disegno completo ---------- */
var inCorso = false;
function disegna() {
  /* 05/10/2026 sera: le tendine si scelgono a mano e il settore va all'ESP32;
     qui seguono cio' che l'ESP32 dichiara, salvo durante l'attesa di conferma */
  var ult = dati.length ? dati[dati.length - 1] : null;
  if (ult && typeof ult.settore === "string") {
    var fw = chiaveSettore(ult.settore === "generico" ? "" : ult.settore);
    if (settorePendente !== null) {
      if (fw === settorePendente) { settorePendente = null; nota("Settore confermato dall'ESP32."); }
      else if (Date.now() - pendenteDal > 20000) {
        settorePendente = null;
        nota("L'ESP32 non ha confermato il nuovo settore: resta «" + (fw || "generico") + "».", true);
      }
    }
    if (settorePendente === null && (fw === "" || SETTORI[fw]) && cfg.settore !== fw) {
      cfg.settore = fw; salvaCfg();
      ["selSettore", "fSettore"].forEach(function (id) { var e = $(id); if (e) e.value = fw; });
    }
  }
  if (inCorso) return;
  inCorso = true;
  requestAnimationFrame(function () {
    inCorso = false;
    var c = finestra();
    riquadroPrincipale();
    riquadri();
    if (!pointerGiu) grafico(c);      /* col dito appoggiato il grafico resta fermo */
    if (ricevuti) {
      nota("Ricevuti <strong>" + ricevuti + "</strong> campioni · ultimo alle " +
           ora(ultimoArrivo) + " · " + c.length + " punti nella finestra");
    }
  });
}

/* ---------- settore del sito (02/10/2026): tendina sulla schermata principale ---------- */
cfg.settore = chiaveSettore(cfg.settore || "");
$("selSettore").value = SETTORI[cfg.settore] ? cfg.settore : "";
var settorePendente = null, pendenteDal = 0;
if (cfg.sola === "1") {
  ["selSettore", "fSettore"].forEach(function (id) {
    var e = $(id); if (e) { e.disabled = true; e.title = "Sola lettura: il settore lo imposta Ferdinando"; }
  });
}
function inviaSettore(v) {
  if (cfg.sola === "1") return;   /* sola lettura: nessun comando all'ESP32 */
  if (!client || !client.connected) {
    nota("Settore non inviato all'ESP32: l'app non e' collegata al broker.", true);
    return;
  }
  client.publish((cfg.topic || CFG_DEF.topic) + "/settore", v || "generico", { qos: 1, retain: true });
  settorePendente = v; pendenteDal = Date.now();
  nota("Settore «" + (v || "generico") + "» inviato all'ESP32, in attesa di conferma…");
}
$("selSettore").addEventListener("change", function () {
  cfg.settore = this.value;
  salvaCfg();
  inviaSettore(cfg.settore);
  disegna();            /* nessuna riconnessione: cambia solo la stima del THDi */
});

/* ---------- finestre temporali ---------- */
var FIN = [ [60, "1 min"], [300, "5 min"], [900, "15 min"], [3600, "1 ora"] ];
$("finestre").innerHTML = FIN.map(function (f) {
  return '<button class="chip" data-s="' + f[0] + '" aria-selected="' + (f[0] === finestraSec) + '">' + f[1] + "</button>";
}).join("");

$("finestre").addEventListener("click", function (ev) {
  var b = ev.target.closest(".chip");
  if (!b) return;
  finestraSec = parseInt(b.dataset.s, 10);
  Array.prototype.forEach.call(this.children, function (x) {
    x.setAttribute("aria-selected", x === b);
  });
  disegna();
});

$("chips").addEventListener("click", function (ev) {
  var b = ev.target.closest(".chip");
  if (!b) return;
  vista = b.dataset.v;
  Array.prototype.forEach.call(this.children, function (x) {
    x.setAttribute("aria-selected", x === b);
  });
  disegna();
});

/* ---------- tema ---------- */
try {
  var t = localStorage.getItem("cruscottofv.tema");
  if (t) document.documentElement.setAttribute("data-theme", t);
} catch (e) {}

$("btnTema").addEventListener("click", function () {
  var r = document.documentElement;
  var scuro = r.getAttribute("data-theme") === "dark" ||
              (!r.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  r.setAttribute("data-theme", scuro ? "light" : "dark");
  try { localStorage.setItem("cruscottofv.tema", scuro ? "light" : "dark"); } catch (e) {}
  disegna();
});

/* ---------- schermo sempre acceso ---------- */
/* Disponibile solo in contesto sicuro (https o localhost): su http semplice
   l'API non esiste e la riga resta nascosta invece di promettere il falso. */
var veglia = null, vegliaVoluta = false;
if ("wakeLock" in navigator) {
  $("rigaVeglia").hidden = false;
  try { vegliaVoluta = localStorage.getItem("cruscottofv.veglia") === "1"; } catch (e) {}
  aggiornaVeglia();
}
function aggiornaVeglia() {
  var b = $("btnVeglia");
  b.setAttribute("aria-pressed", vegliaVoluta);
  b.textContent = vegliaVoluta ? "Sì" : "No";
  if (vegliaVoluta) chiediVeglia(); else rilasciaVeglia();
}
function chiediVeglia() {
  if (veglia || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  navigator.wakeLock.request("screen").then(function (w) {
    veglia = w;
    w.addEventListener("release", function () { veglia = null; });
  }).catch(function () {});
}
function rilasciaVeglia() { if (veglia) { try { veglia.release(); } catch (e) {} veglia = null; } }
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible" && vegliaVoluta) chiediVeglia();
});
$("btnVeglia").addEventListener("click", function () {
  vegliaVoluta = !vegliaVoluta;
  try { localStorage.setItem("cruscottofv.veglia", vegliaVoluta ? "1" : "0"); } catch (e) {}
  aggiornaVeglia();
});

/* ---------- foglio delle impostazioni ---------- */
var dlg = $("dlg");
function apriImpostazioni() {
  $("fProto").value = cfg.proto;
  $("fHost").value  = cfg.host;
  $("fPorta").value = cfg.porta;
  $("fTopic").value = cfg.topic;
  $("fUser").value  = cfg.user;
  $("fPass").value  = cfg.pass;
  $("fSettore").value = SETTORI[cfg.settore] ? cfg.settore : "";
  dlg.showModal();
}
$("btnImp").addEventListener("click", apriImpostazioni);
$("btnAnnulla").addEventListener("click", function () { dlg.close(); });
$("btnSalva").addEventListener("click", function () {
  cfg.proto = $("fProto").value;
  cfg.host  = $("fHost").value.trim().replace(/^\w+:\/\//, "").replace(/\/.*$/, "");
  cfg.porta = ($("fPorta").value.trim() || "9001").replace(/\D/g, "");
  cfg.topic = $("fTopic").value.trim() || CFG_DEF.topic;
  cfg.user  = $("fUser").value.trim();
  cfg.pass  = $("fPass").value;
  var settorePrima = cfg.settore;
  cfg.settore = $("fSettore").value;
  $("selSettore").value = cfg.settore;
  if (cfg.settore !== settorePrima) setTimeout(function () { inviaSettore(cfg.settore); }, 3000);
  salvaCfg();
  dlg.close();
  /* un cambio di broker rende i campioni vecchi non confrontabili */
  dati = []; ricevuti = 0; trifase = true; conThd = true; gradiniVde = [];
  costruisciChips();
  disegna();
  collega();
});

/* ---------- sentinella: i campioni hanno smesso di arrivare? ---------- */
setInterval(function () {
  if (ricevuti && Date.now() - ultimoArrivo > 12000) {
    setStato("off", "Fermo da " + Math.round((Date.now() - ultimoArrivo) / 1000) + " s");
  }
}, 3000);

/* ---------- ridisegno al cambio di larghezza (rotazione schermo) ---------- */
var larghezza = window.innerWidth;
window.addEventListener("resize", function () {
  if (Math.abs(window.innerWidth - larghezza) < 2) return;   /* la tastiera non conta */
  larghezza = window.innerWidth;
  clearTimeout(window.__rz);
  window.__rz = setTimeout(disegna, 160);
});

/* ---------- avvio ---------- */
costruisciChips();
riquadri();
disegna();

if (!cfg.host) apriImpostazioni();
else collega();

/* ---------- service worker: l'app parte anche senza rete ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  });
}

})();
