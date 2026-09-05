/**
 * bccs-handler.js
 * ===============
 * Äiá»u khiá»ƒn SFive browser (Viettel) qua Chrome DevTools Protocol (CDP)
 * báº±ng thÆ° viá»‡n chrome-remote-interface.
 *
 * LÃ½ do dÃ¹ng SFive thay vÃ¬ Playwright Chromium:
 *   - BCCS kiá»ƒm tra KPI Addon + modifyHeader â€” SFive cÃ³ built-in, Playwright khÃ´ng cÃ³.
 *   - Playwright block bá»Ÿi SFive vÃ¬ SFive (Chrome 80) khÃ´ng há»— trá»£
 *     Browser.setDownloadBehavior mÃ  Playwright gá»i khi connectOverCDP.
 *   - chrome-remote-interface dÃ¹ng raw CDP WebSocket â†’ khÃ´ng gá»i lá»‡nh Ä‘Ã³ â†’ OK.
 *
 * LUá»’NG CHÃNH:
 *   [1] Kill SFive cÅ© â†’ Launch SFive vá»›i --remote-debugging-port=9222
 *   [2] Connect CDP qua chrome-remote-interface
 *   [3] Login tá»± Ä‘á»™ng (SFive pass KPI + modifyHeader check)
 *   [4] Navigate â†’ stracking.jsf
 *   [5] Äiá»n form: KH â†’ Sáº£n pháº©m â†’ ThuÃª bao â†’ Thanh toÃ¡n â†’ Há»“ sÆ¡
 *   [6] Captcha (pause Enter) â†’ Submit
 *   [*] Äá»‹a chá»‰ â€” Bá»Ž QUA (sáº½ xá»­ lÃ½ sau)
 *
 * Cáº¥u hÃ¬nh .env:
 *   BCCS_LOGIN_URL   â€” URL SSO login
 *   BCCS_ENTRY_URL   â€” URL stracking.jsf
 *   BCCS_USERNAME    â€” TÃªn Ä‘Äƒng nháº­p
 *   BCCS_PASSWORD    â€” Máº­t kháº©u
 *   BCCS_SFIVE_PATH  â€” ÄÆ°á»ng dáº«n sfive.exe
 *
 * Export:
 *   runBCCS(masterData, testMode?) â†’ Promise<{ success, duration_ms, test_mode }>
 */

"use strict";

require("dotenv").config();
const path                    = require("path");
const fs                      = require("fs");
const { spawn, execSync }     = require("child_process");
const captchaBridge           = require("./captcha-bridge"); // cầu nối captcha ↔ giao diện tool
const billingBridge           = require("./billing-bridge"); // cầu nối sửa Địa chỉ hóa đơn cước ↔ giao diện
let CDP;

// â”€â”€â”€ Mock Mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// true  â†’ Load bccs-mock.html local thay vÃ¬ URL tháº­t
// false â†’ Cháº¡y tháº­t: launch SFive â†’ login â†’ fill form
const IS_MOCK_TEST = process.env.BCCS_MOCK_TEST === "true";

// â”€â”€â”€ Config tá»« .env â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const BCCS_LOGIN_URL  = process.env.BCCS_LOGIN_URL  || "https://PLACEHOLDER_BCCS_LOGIN_URL";
const BCCS_ENTRY_URL  = process.env.BCCS_ENTRY_URL  || "http://10.240.147.109:8400/SALE_WEB/stracking.jsf";
const BCCS_USERNAME   = process.env.BCCS_USERNAME   || "PLACEHOLDER_USERNAME";
const BCCS_PASSWORD   = process.env.BCCS_PASSWORD   || "PLACEHOLDER_PASSWORD";
const BCCS_SFIVE_PATH = process.env.BCCS_SFIVE_PATH ||
  "C:\\Program Files (x86)\\Viettel\\SFive\\Application\\sfive.exe";
const CDP_PORT        = 9222;
const RUNTIME_ROOT    = process.pkg ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
const SCREENSHOT_DIR  = path.join(RUNTIME_ROOT, "logs", "errors");

// â”€â”€â”€ Timing (ms) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const T = {
  page_load:   5000,  // chá» sau khi goto
  after_fill:   400,  // chá» sau khi fill/select
  after_click:  700,  // chá» sau khi click
  ajax_wait:   2000,  // chá» PrimeFaces xá»­ lÃ½ AJAX
  dropdown:    1500,  // chá» autocomplete dropdown hiá»‡n
  form_ready: 20000,  // timeout chá» form JSF render láº§n Ä‘áº§u
};

// â”€â”€â”€ Selectors â€” Login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEL_LOGIN_USER = [
  'input[name="username"]', 'input[name="user"]',
  'input[id="username"]',   'input[type="text"]',
];
const SEL_LOGIN_PASS = [
  'input[name="password"]', 'input[id="password"]',
  'input[type="password"]',
];
const SEL_LOGIN_BTN = [
  'button[type="submit"]',  'input[type="submit"]',
  '#btnLogin',              '.btn-login',
  'input[value="ÄÄ‚NG NHáº¬P"]', 'button:contains("ÄÄ‚NG NHáº¬P")',
];

// â”€â”€â”€ Selectors â€” Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEL_MENU_GPCNTT    = '[id="form_menu:menu_1"] > a';
const SEL_MENU_CCPDV     = '[id="form_menu:menu_1_2"] > a';
const SEL_MENU_STRACKING = '[id="form_menu:menu_1_2_1"] a';

// â”€â”€â”€ Selectors â€” ThÃ´ng tin khÃ¡ch hÃ ng â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEL_ID_TYPE         = '[id="connectForm:j_idt108:mainCustomercbxIdType_input"]';
const SEL_ID_NUMBER       = '[id="connectForm:j_idt108:mainCustomertxtIdNoCust_input"]';
const SEL_CCCD_SEARCH_BTN = '[id="connectForm:j_idt108:j_idt167"]';
// Selector dropdown CCCD â€” thá»­ nhiá»u pattern vÃ¬ cÃ³ thá»ƒ lÃ  autocomplete panel hoáº·c dialog
const SEL_CCCD_RESULT =
  '[id*="mainCustomertxtIdNoCust_panel"] tr.ui-widget-content, ' +
  '[id*="mainCustomertxtIdNoCust_panel"] li, ' +
  '[id*="mainCustomertxtIdNoCust"] tr.ui-widget-content, ' +
  '.ui-autocomplete-panel tr.ui-widget-content, ' +
  '.ui-autocomplete-panel li.ui-autocomplete-item, ' +
  '[id*="mainCustomerdlgIdNo"] tr.ui-widget-content, ' +
  '[id*="mainCustomerdlgIdNo"] tr[data-ri]';
const SEL_ISSUE_PLACE     = '[id="connectForm:j_idt108:mainCustomertxtPlaceIss"]';
const SEL_ISSUE_DATE      = '[id="connectForm:j_idt108:mainCustomercldDate_input"]';
const SEL_OWNER_NAME      = '[id="connectForm:j_idt108:mainCustomertxtHoten"]';
const SEL_BIRTHDAY        = '[id="connectForm:j_idt108:mainCustomercldDOB_input"]';
const SEL_EXPIRE_DATE     = '[id$="mainCustomerexpireCldDate_input"]'; // Ngày hết hạn
const SEL_GENDER_NAM      = '[id="connectForm:j_idt108:mainCustomersorGender:0"]';
const SEL_GENDER_NU       = '[id="connectForm:j_idt108:mainCustomersorGender:1"]';

// â”€â”€â”€ Selectors â€” ThÃ´ng tin sáº£n pháº©m â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEL_PACKAGE_INPUT  = '[id="connectForm:packageId-_input"]';
// Panel chá»©a tá»«ng gÃ³i â€” click vÃ o panel Ä‘á»ƒ chá»n
const SEL_PANEL_12M = '[id="connectForm:panelListRealtion01"]';
const SEL_PANEL_6M  = '[id="connectForm:panelListRealtion02"]';
const SEL_PANEL_3M  = '[id="connectForm:panelListRealtion03"]';
// Hidden input bÃªn trong panel â€” dispatch change Ä‘á»ƒ trigger PrimeFaces AJAX
const SEL_RADIO_12M = '[id="connectForm:customRadio0:1_clone"]';
const SEL_RADIO_6M  = '[id="connectForm:customRadio0:2_clone"]';
const SEL_RADIO_3M  = '[id="connectForm:customRadio0:3_clone"]';

// â”€â”€â”€ Selectors â€” ThÃ´ng tin thuÃª bao â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEL_SUB_TYPE    = '[id="connectForm:cbxProductOffering_input"]';
const SEL_SERIAL      = '[id="connectForm:serialAssignedAgents"]';
const SEL_RELOAD_ISDN = 'a[title="Sinh Account"], [id="connectForm:panelNumberSelection"] a.ui-commandlink';
const SEL_BIEN_SO     = '[id="connectForm:isdnAccountplate"]';

// --- Selectors --- Danh sach thiet bi kem theo (tblSubgoodsStracking) ---
// Dung class on dinh thay cho id j_idt tu sinh cua PrimeFaces.
const SEL_SUBGOODS_DEVICE   = '.subGoodsItem0 select';        // Thiet bi (select onemenu)
const SEL_SUBGOODS_SUPPLY   = '.cbxListSupplyMethod0 select'; // Hinh thuc cung cap
const SEL_SUBGOODS_SERIAL   = '[id$="tblSubgoodsStracking:0:serial"]'; // Serial (= .txtSerial0)
const SUBGOODS_DEVICE_TEXT  = "S-Tracking V03"; // chon option chua chuoi nay
const SUBGOODS_SUPPLY_TEXT  = "Bán đứt";

// â”€â”€â”€ Selectors â€” ThÃ´ng tin thanh toÃ¡n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Dùng khớp đuôi [id$="..."] để miễn nhiễm với j_idt#### tự sinh (đã đổi 1904→1906).
const SEL_BILLING_ADDR  = '[id$="svAccountInfo:txtAddressNoticeCharge"]'; // Địa chỉ hóa đơn cước
const SEL_BILL_CYCLE    = '[id$="svAccountInfo:cbxViewBillCycle_input"]';
const SEL_PAY_METHOD    = '[id$="svAccountInfo:cbxViewPayMethod_input"]';
const SEL_NOTICE_CHARGE = '[id$="svAccountInfo:cbxViewNoticeCharge_input"]';
const SEL_PRINT_METHOD  = '[id$="svAccountInfo:cbxViewPrintMethod_input"]';
const SEL_PHONE         = '[id$="svAccountInfo:txtTelPhone"]';
const SEL_PHONE_2       = 'input[title="Số điện thoại thứ 2"], input[data-p-label="Số điện thoại thứ 2"], input[id$=":txtAddInfo"]';

// Address popup configs â€” kept separate so we can wire them into the main BCCS
// flow only after the address data model is finalized.
// Selector địa chỉ dùng KHỚP ĐUÔI [id$="..."] / [class*="..."] để miễn nhiễm với
// phần j_idt#### tự sinh của PrimeFaces (đã đổi 1724→1726 trên trang thật).
const ADDRESS_POPUPS = {
  // Dia chi khach hang (Thong tin KH) - modal giong dia chi lap dat.
  customer: {
    label: "Dia chi KH",
    openInput: '[id$="input_for_address_mainCustomertxtAdd_txt"]',
    openFunction: "reload_mainCustomertxtAdd_location",
    province: '[id$="mainCustomertxtAddprovince_input"]',
    district: '[id$="mainCustomertxtAdddistrict_input"]',
    precinct: '[id$="mainCustomertxtAddprecinct_input"]',
    groupStreet: '[id$="mainCustomertxtAddgroupStreet_input"]',
    // Chỉ điền Tỉnh/Huyện/Xã/Tổ-thôn — KHÔNG điền Đường/phố (street) & Số nhà.
    saveButton: '[class*="mainCustomertxtAddbtnSumitLocation"]',
    dialog: '[id$="pnAddressmainCustomertxtAdd"]',
  },
  install: {
    label: "Dia chi lap dat",
    openInput: '[id$="input_for_address_txtDeploymentAddressSip_txt2"]',
    openFunction: "reload_txtDeploymentAddressSip_location",
    province: '[id$="txtDeploymentAddressSipprovince_input"]',
    district: '[id$="txtDeploymentAddressSipdistrict_input"]',
    precinct: '[id$="txtDeploymentAddressSipprecinct_input"]',
    groupStreet: '[id$="txtDeploymentAddressSipgroupStreet_input"]',
    saveButton: ".txtDeploymentAddressSipbtnSumitLocation",
    dialog: ".atxtDeploymentAddressSipdlgLocation",
  },
  billing: {
    label: "Dia chi XM/TBC",
    openInput: '[id$="txtAccAddressXmtt_txt2"]',
    openFunction: "reload_j_idt1904txtAccAddressXmtt_location",
    province: '[id$="txtAccAddressXmttprovince_input"]',
    district: '[id$="txtAccAddressXmttdistrict_input"]',
    precinct: '[id$="txtAccAddressXmttprecinct_input"]',
    groupStreet: '[id$="txtAccAddressXmttgroupStreet_input"]',
    street: '[id$="txtAccAddressXmttstreetPro"]',
    noApartment: '[id$="txtAccAddressXmttnoApartment"]',
    saveButton: '[class*="txtAccAddressXmttbtnSumitLocation"]',
    dialog: '[class*="txtAccAddressXmttdlgLocation"]',
  },
  billingNew: {
    label: "Dia chi XM/TBC moi",
    openInput: '[id$="txtAccAddressXmttNew_txt2"]',
    openFunction: "reload_j_idt1904txtAccAddressXmttNew_location",
    province: '[id$="txtAccAddressXmttNewprovince_input"]',
    precinct: '[id$="txtAccAddressXmttNewprecinct_input"]',
    groupStreet: '[id$="txtAccAddressXmttNewgroupStreet_input"]',
    street: '[id$="txtAccAddressXmttNewstreetPro"]',
    saveButton: '[class*="txtAccAddressXmttNewbtnSumitLocation"]',
    dialog: '[class*="txtAccAddressXmttNewdlgLocation"]',
  },
};

// â”€â”€â”€ Selectors â€” Há»“ sÆ¡ Ä‘Ã­nh kÃ¨m â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const DOCUMENT_SLOTS = [
  { index: 0, key: "file_bbnt",       label: "BiÃªn báº£n nghiá»‡m thu", type: "BBNT"   },
  { index: 1, key: "file_cmnd_sau",   label: "CMND máº·t sau",        type: "CMNDMS" },
  { index: 2, key: "file_cmnd_truoc", label: "CMND máº·t trÆ°á»›c",      type: "CMNDMT" },
  { index: 3, key: "file_hop_dong",   label: "Há»£p Ä‘á»“ng",            type: "HD"     },
  { index: 4, key: "file_phu_luc",    label: "Phá»¥ lá»¥c há»£p Ä‘á»“ng",    type: "PLHD"   },
];

// â”€â”€â”€ Selectors â€” Captcha & Submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SEL_CAPTCHA_INPUT  = '[id="connectForm:capcha:capcha1"], input[data-p-label="Mã xác nhận"], input.acapchapinputCaptcha';
const SEL_CAPTCHA_IMG    = '[id="connectForm:capcha:captchaImg"]';
const SEL_CAPTCHA_RELOAD = '.fcapcha, [id="connectForm:capcha:j_idt5320"], [id="connectForm:capcha:j_idt5329"]';
// Miễn nhiễm j_idt#### tự sinh: khớp tiền tố id ổn định + class đặc trưng của từng nút.
//  - Đấu nối:  class .w210 (nút chính)
//  - Đồng ý:   class .yesButtoncfDoConnectPanel (nút xác nhận trong panel)
const SEL_BTN_DAU_NOI   = '[id^="connectForm:buttonDoConnectId:"].w210';
const SEL_BTN_DONG_Y    = '[id^="connectForm:buttonDoConnectId:"].yesButtoncfDoConnectPanel';

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function screenshotOnError(page, tag) {
  try {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(SCREENSHOT_DIR, `bccs_${tag}_${ts}.png`);
    await page.screenshot({ path: file });
    console.error(`  ðŸ“¸ Screenshot: ${file}`);
  } catch { /* bá» qua lá»—i chá»¥p */ }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SFivePage â€” Wrapper CDP thay tháº¿ Playwright page
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
/**
 * Bá»c chrome-remote-interface thÃ nh API tÆ°Æ¡ng tá»± Playwright page.
 * Há»— trá»£: goto, fill, selectOption, click, typeText, setInputFiles,
 *         waitForSelector, waitForNavigation, screenshot, pause.
 */
class SFivePage {
  constructor(client) {
    this.client  = client;
    this._url    = "about:blank";
  }

  url() { return this._url; }

  /** Báº­t cÃ¡c CDP domain cáº§n thiáº¿t */
  async _init() {
    const { Page, Runtime, DOM, Network, Input } = this.client;
    this.Page    = Page;
    this.Runtime = Runtime;
    this.DOM     = DOM;
    this.Network = Network;
    this.Input   = Input;
    await Promise.all([
      Page.enable(),
      Runtime.enable(),
      DOM.enable(),
      Network.enable(),
    ]);
  }

  // â”€â”€ Evaluate JavaScript trong browser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async evaluate(expression) {
    const { result, exceptionDetails } = await this.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const msg = exceptionDetails.exception?.description
               || exceptionDetails.text
               || "JS Error";
      throw new Error(msg);
    }
    return result?.value;
  }

  // â”€â”€ Navigate Ä‘áº¿n URL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async goto(url, { timeout = 20000 } = {}) {
    this._url = url;
    // chrome-remote-interface: events báº¯n trÃªn client vá»›i tÃªn "Domain.eventName"
    const loaded = new Promise(r => this.client.once("Page.loadEventFired", r));
    await this.Page.navigate({ url });
    await Promise.race([loaded, sleep(timeout)]);
    await sleep(500);
    try { this._url = await this.evaluate("window.location.href") || url; } catch {}
  }

  // â”€â”€ Chá» element xuáº¥t hiá»‡n â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async waitForSelector(selector, { timeout = 10000, state = "visible" } = {}) {
    const attached = state === "attached";
    const script   = attached
      ? `!!document.querySelector(${JSON.stringify(selector)})`
      : `(function() {
           const el = document.querySelector(${JSON.stringify(selector)});
           if (!el) return false;
           const st = window.getComputedStyle(el);
           return st.display !== 'none'
               && st.visibility !== 'hidden'
               && el.offsetParent !== null;
         })()`;

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const found = await this.evaluate(script).catch(() => false);
      if (found) return;
      await sleep(200);
    }
    throw new Error(`Timeout ${timeout}ms â€” khÃ´ng tÃ¬m tháº¥y: ${selector}`);
  }

  // â”€â”€ Fill input â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async fill(selector, value, { timeout = 10000 } = {}) {
    await this.waitForSelector(selector, { timeout });
    await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        // DÃ¹ng native setter Ä‘á»ƒ React/Vue input nháº­n event
        const setter =
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
          Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(String(value))});
        else el.value = ${JSON.stringify(String(value))};
        ['input', 'change', 'blur'].forEach(e =>
          el.dispatchEvent(new Event(e, { bubbles: true }))
        );
      })()
    `);
    await sleep(T.after_fill);
  }

  // â”€â”€ Select option (há»— trá»£ value string / { label } / { index }) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async selectOption(selector, value, { timeout = 10000 } = {}) {
    await this.waitForSelector(selector, { timeout });

    let script;
    if (value !== null && typeof value === "object") {
      if ("label" in value) {
        script = `
          (function() {
            const el  = document.querySelector(${JSON.stringify(selector)});
            const opt = Array.from(el.options).find(
              o => o.text.trim() === ${JSON.stringify(value.label)}
            );
            if (!opt) throw new Error('Option not found: ${value.label}');
            el.value = opt.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`;
      } else if ("index" in value) {
        script = `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            el.selectedIndex = ${Number(value.index)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`;
      } else if ("value" in value) {
        script = `
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            el.value = ${JSON.stringify(value.value)};
            el.dispatchEvent(new Event('change', { bubbles: true }));
          })()`;
      }
    } else {
      script = `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`;
    }

    await this.evaluate(script);
    await sleep(T.after_fill);
  }

  // â”€â”€ Click element â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async click(selector, { timeout = 10000, force = false } = {}) {
    if (!force) await this.waitForSelector(selector, { timeout });
    await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Click target not found: ${selector}');
        el.click();
      })()
    `);
    await sleep(T.after_click);
  }

  // â”€â”€ Type kÃ½ tá»± (dÃ¹ng cho datepicker PrimeFaces) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async typeText(selector, text, { delay = 80 } = {}) {
    await this.waitForSelector(selector);
    // Focus vÃ  clear trÆ°á»›c
    await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        el.value = '';
      })()
    `);
    // GÃµ tá»«ng kÃ½ tá»± qua Input.dispatchKeyEvent
    for (const char of text) {
      await this.Input.dispatchKeyEvent({ type: "char", text: char });
      await sleep(delay);
    }
    // Tab Ä‘á»ƒ datepicker format láº¡i
    await this.Input.dispatchKeyEvent({ type: "keyDown", key: "Tab", keyCode: 9, nativeVirtualKeyCode: 9 });
    await this.Input.dispatchKeyEvent({ type: "keyUp",   key: "Tab", keyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(T.after_fill);
  }

  // â”€â”€ GÃµ tá»«ng kÃ½ tá»± cháº­m, con trá» á»Ÿ láº¡i field (khÃ´ng nháº¥n Tab) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // DÃ¹ng cho CCCD â€” dÃ¹ng Input.insertText Ä‘á»ƒ thá»±c sá»± chÃ¨n kÃ½ tá»± vÃ o DOM,
  // káº¿t há»£p keyDown/keyUp Ä‘á»ƒ PrimeFaces autocomplete listener báº¯t Ä‘Æ°á»£c.
  async typeSlowly(selector, text, { delay = 120 } = {}) {
    await this.waitForSelector(selector);

    // Focus vÃ  clear field qua JS
    await this.evaluate(`
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()
    `);

    for (const char of text) {
      const code = char.charCodeAt(0);

      // keyDown â€” Ä‘á»ƒ PrimeFaces autocomplete listener nháº­n Ä‘Æ°á»£c key event
      await this.Input.dispatchKeyEvent({
        type: "keyDown",
        key: char,
        keyCode: code,
        nativeVirtualKeyCode: code,
      });

      // insertText â€” thá»±c sá»± chÃ¨n kÃ½ tá»± vÃ o input (cÃ¡ch Ä‘Ãºng vá»›i CDP)
      await this.Input.insertText({ text: char });

      // keyUp â€” trigger PrimeFaces search sau khi nháº­n Ä‘á»§ kÃ½ tá»±
      await this.Input.dispatchKeyEvent({
        type: "keyUp",
        key: char,
        keyCode: code,
        nativeVirtualKeyCode: code,
      });

      await sleep(delay);
    }
    // KHÃ”NG nháº¥n Tab â€” giá»¯ focus Ä‘á»ƒ dropdown ká»‹p hiá»‡n
  }

  // â”€â”€ Upload file vÃ o input[type=file] â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async setInputFiles(selector, filePath, { state = "attached" } = {}) {
    await this.waitForSelector(selector, { state });
    const files = Array.isArray(filePath) ? filePath : [filePath];
    // Cáº§n nodeId Ä‘á»ƒ gá»i DOM.setFileInputFiles
    const { root } = await this.DOM.getDocument({ depth: -1 });
    const { nodeId } = await this.DOM.querySelector({ nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`File input not found: ${selector}`);
    await this.DOM.setFileInputFiles({ files, nodeId });
    await sleep(T.ajax_wait);
  }

  // â”€â”€ Chá» sau navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async waitForNavigation({ timeout = 15000 } = {}) {
    await Promise.race([
      new Promise(r => this.client.once("Page.loadEventFired", r)),
      sleep(timeout),
    ]);
    await sleep(1000);
    try { this._url = await this.evaluate("window.location.href") || this._url; } catch {}
  }

  // â”€â”€ Chá» URL chá»©a substring â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async waitForURLContains(substring, { timeout = 20000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const url = await this.evaluate("window.location.href").catch(() => "");
      if (url.includes(substring)) {
        this._url = url;
        return;
      }
      await sleep(500);
    }
    // KhÃ´ng throw â€” chá»‰ log warning
    console.warn(`  âš ï¸  waitForURLContains timeout: "${substring}" khÃ´ng xuáº¥t hiá»‡n trong URL.`);
  }

  // â”€â”€ Screenshot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async screenshot({ path: filePath } = {}) {
    try {
      const { data } = await this.Page.captureScreenshot({ format: "png" });
      fs.writeFileSync(filePath, Buffer.from(data, "base64"));
    } catch (err) {
      console.error(`  âš ï¸  Screenshot lá»—i: ${err.message}`);
    }
  }

  // â”€â”€ Pause â€” nháº¥n Enter trong terminal Ä‘á»ƒ tiáº¿p tá»¥c â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async pause() {
    console.log("\n  â¸ï¸  [BCCS] PAUSE â€” Nháº¥n Enter trong terminal Ä‘á»ƒ tiáº¿p tá»¥c...");
    await new Promise(resolve => {
      const handler = () => {
        resolve();
        process.stdin.off("data", handler);
        try { process.stdin.pause(); } catch {}
      };
      process.stdin.resume();
      process.stdin.once("data", handler);
    });
    console.log("  â–¶ï¸  Tiáº¿p tá»¥c.\n");
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Helpers sá»­ dá»¥ng SFivePage (giá»¯ cÃ¹ng signature vá»›i code cÅ©)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function safeFill(page, selector, value, opts = {}) {
  await page.fill(selector, String(value), { timeout: opts.timeout ?? 10000 });
}

async function safeSelect(page, selector, value, opts = {}) {
  await page.selectOption(selector, value, { timeout: opts.timeout ?? 10000 });
}

async function selectNativeAndChange(page, selector, value, opts = {}) {
  await page.waitForSelector(selector, {
    timeout: opts.timeout ?? 10000,
    state: "attached",
  });
  const result = await page.evaluate(`
    (function(sel, val) {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: 'not-found' };
      const opt = Array.from(el.options || []).find(o => o.value === val);
      if (!opt) return { ok: false, reason: 'option-not-found', value: val };

      el.value = val;
      opt.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      const rootId = sel.replace(/\\[id="(.+)_input"\\]/, '$1');
      const label = document.getElementById(rootId + '_label');
      if (label) label.textContent = opt.textContent.trim();

      return { ok: true, label: opt.textContent.trim(), value: val };
    })(${JSON.stringify(selector)}, ${JSON.stringify(value)})
  `);

  if (!result?.ok) {
    throw new Error(`select ${selector}=${value} failed: ${result?.reason || 'unknown'}`);
  }
  if (opts.wait) await sleep(opts.wait);
  return result;
}

async function safeClick(page, selector, opts = {}) {
  await page.click(selector, { timeout: opts.timeout ?? 10000, force: !!opts.force });
  if (opts.wait) await sleep(opts.wait);
}

// Chọn PrimeFaces SelectOneMenu KIỂU CLICK như người thật (mở dropdown → click option).
// Dùng cho các dropdown "nhạy cảm" mà chọc <select> ẩn gây kẹt (vd Chu kỳ cước).
// rootSuffix: đuôi id của div widget (không có _input/_label/_focus).
async function selectOneMenuByClick(page, rootSuffix, optionLabel) {
  await page.evaluate(`
    (function(suffix){
      const root = Array.from(document.querySelectorAll('.ui-selectonemenu'))
        .find(r => r.id && r.id.endsWith(suffix));
      if (!root) return;
      const trig = root.querySelector('.ui-selectonemenu-trigger')
                || root.querySelector('.ui-selectonemenu-label');
      if (trig) trig.click();
    })(${JSON.stringify(rootSuffix)})
  `).catch(() => {});
  await sleep(400);
  const picked = await page.evaluate(`
    (function(label){
      const panels = document.querySelectorAll('.ui-selectonemenu-panel');
      let panel = null;
      for (const p of panels) {
        const s = getComputedStyle(p);
        if (s.display !== 'none' && s.visibility !== 'hidden') { panel = p; break; }
      }
      if (!panel) return null;
      const items = panel.querySelectorAll('li.ui-selectonemenu-item');
      for (const it of items) {
        const l = (it.getAttribute('data-label') || it.textContent || '').trim();
        if (l === label) { it.click(); return l; }
      }
      return null;
    })(${JSON.stringify(optionLabel)})
  `).catch(() => null);
  await sleep(300);
  return { label: picked || optionLabel, ok: !!picked };
}

async function pressKey(page, key) {
  const keyMap = {
    F8: { key: "F8", code: "F8", keyCode: 119 },
    F9: { key: "F9", code: "F9", keyCode: 120 },
    Enter: { key: "Enter", code: "Enter", keyCode: 13 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Esc: { key: "Escape", code: "Escape", keyCode: 27 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  };
  const k = keyMap[key];
  if (!k) throw new Error(`Unsupported key: ${key}`);

  await page.Input.dispatchKeyEvent({
    type: "keyDown",
    key: k.key,
    code: k.code,
    keyCode: k.keyCode,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
  });
  await page.Input.dispatchKeyEvent({
    type: "keyUp",
    key: k.key,
    code: k.code,
    keyCode: k.keyCode,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode,
  });
}

async function clickFirstAutocompleteOption(page, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate(`
      (function() {
        const panels = Array.from(document.querySelectorAll('.ui-autocomplete-panel'));
        for (const panel of panels) {
          const st = window.getComputedStyle(panel);
          if (st.display === 'none' || st.visibility === 'hidden') continue;

          const option = panel.querySelector(
            'li.ui-autocomplete-item, tr.ui-widget-content, td, .ui-autocomplete-item'
          );
          if (option) {
            option.click();
            return true;
          }
        }
        return false;
      })()
    `).catch(() => false);

    if (clicked) {
      await sleep(T.ajax_wait);
      return;
    }
    await sleep(250);
  }
  throw new Error("Autocomplete option did not render.");
}

async function tryClickFirstAutocompleteOption(page, timeout = 2000) {
  try {
    await clickFirstAutocompleteOption(page, timeout);
    return true;
  } catch {
    return false;
  }
}

async function clickAutocompleteOptionByText(page, text, timeout = 8000) {
  const start = Date.now();
  const needle = String(text || "").trim().toLowerCase();
  if (!needle) return false;

  while (Date.now() - start < timeout) {
    const clicked = await page.evaluate(`
      (function(needle) {
        const panels = Array.from(document.querySelectorAll('.ui-autocomplete-panel'));
        for (const panel of panels) {
          const st = window.getComputedStyle(panel);
          if (st.display === 'none' || st.visibility === 'hidden') continue;

          const options = Array.from(panel.querySelectorAll(
            'li.ui-autocomplete-item, tr.ui-widget-content, .ui-autocomplete-item'
          ));
          for (const option of options) {
            const value = (option.getAttribute('data-item-value') || '').trim().toLowerCase();
            const firstCell = (
              option.querySelector('td:first-child')?.textContent ||
              option.querySelector('label')?.textContent ||
              ''
            ).trim().toLowerCase();
            if (value === needle || firstCell === needle) {
              option.click();
              return true;
            }
          }
          for (const option of options) {
            const label = (
              option.getAttribute('data-item-label') ||
              option.getAttribute('data-label') ||
              option.textContent ||
              ''
            ).trim().toLowerCase();
            if (label.startsWith(needle + ' -')) {
              option.click();
              return true;
            }
          }
        }
        return false;
      })(${JSON.stringify(needle)})
    `).catch(() => false);
    if (clicked) return true;
    await sleep(250);
  }
  return false;
}

async function triggerPrimeFacesAutocompleteSearch(page, selector) {
  return page.evaluate(`
    (function(sel) {
      const input = document.querySelector(sel);
      if (!input) return false;

      const id = input.id || "";
      const widgetName = id.split(":").pop().replace(/_input$/, "");
      if (!widgetName || typeof window.PF !== "function") return false;

      const widget = window.PF(widgetName);
      if (!widget || typeof widget.search !== "function") return false;

      if (typeof widget.activate === "function") widget.activate();
      widget.search(input.value);
      return true;
    })(${JSON.stringify(selector)})
  `).catch(() => false);
}

async function setAutocompleteText(page, selector, value) {
  await page.evaluate(`
    (function(sel, value) {
      const el = document.querySelector(sel);
      if (!el) return false;

      el.focus();
      el.click();

      const setter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      for (const ch of String(value)) {
        const code = ch.charCodeAt(0);
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: ch,
          keyCode: code,
          which: code,
          bubbles: true
        }));
        el.dispatchEvent(new KeyboardEvent('keyup', {
          key: ch,
          keyCode: code,
          which: code,
          bubbles: true
        }));
      }
      return true;
    })(${JSON.stringify(selector)}, ${JSON.stringify(String(value || ""))})
  `);
}

// Chuẩn hóa tên VAS để so khớp (bỏ dấu, thường hóa).
function normalizeVasName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d").replace(/Đ/g, "D")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Đọc option đang hiện trong panel autocomplete: [{index, code, name}].
async function readAutocompleteOptions(page) {
  return page.evaluate(`
    (function(){
      const panels = Array.from(document.querySelectorAll('.ui-autocomplete-panel'))
        .filter(function(p){ const s = getComputedStyle(p); return s.display!=='none' && s.visibility!=='hidden'; });
      for (const panel of panels) {
        const rows = Array.from(panel.querySelectorAll('tr.ui-widget-content, li.ui-autocomplete-item, .ui-autocomplete-item'));
        if (!rows.length) continue;
        return rows.map(function(r, i){
          const tds = Array.from(r.querySelectorAll('td'));
          let code = '', name = '';
          if (tds.length >= 2) {
            code = (tds[0].textContent||'').trim();
            name = tds.slice(1).map(function(td){ return (td.textContent||'').trim(); }).filter(Boolean).join(' ').trim();
          } else {
            const t = (r.textContent||'').trim();
            const m = t.match(/^(\\S+)\\s+([\\s\\S]*)$/);
            if (m) { code = m[1]; name = m[2].trim(); } else { name = t; }
          }
          return { index: i, code: code, name: name };
        });
      }
      return [];
    })()
  `).catch(() => []);
}

// Click option theo index trong panel đang hiện.
async function clickAutocompleteOptionByIndex(page, index) {
  return page.evaluate(`
    (function(idx){
      const panels = Array.from(document.querySelectorAll('.ui-autocomplete-panel'))
        .filter(function(p){ const s = getComputedStyle(p); return s.display!=='none' && s.visibility!=='hidden'; });
      for (const panel of panels) {
        const rows = Array.from(panel.querySelectorAll('tr.ui-widget-content, li.ui-autocomplete-item, .ui-autocomplete-item'));
        if (rows[idx]) { rows[idx].click(); return true; }
      }
      return false;
    })(${Number(index)})
  `).catch(() => false);
}

// Click option theo MÃ (đọc TƯƠI tại thời điểm click → không lệ thuộc index cũ,
// miễn nhiễm với việc panel bị render lại/đổi thứ tự giữa lúc đọc và lúc click).
async function clickAutocompleteOptionByCode(page, code) {
  const want = String(code || "").trim();
  if (!want) return false;
  return page.evaluate(`
    (function(wantCode){
      const panels = Array.from(document.querySelectorAll('.ui-autocomplete-panel'))
        .filter(function(p){ const s = getComputedStyle(p); return s.display!=='none' && s.visibility!=='hidden'; });
      for (const panel of panels) {
        const rows = Array.from(panel.querySelectorAll('tr.ui-widget-content, li.ui-autocomplete-item, .ui-autocomplete-item'));
        for (const r of rows) {
          const tds = r.querySelectorAll('td');
          const code = tds.length ? (tds[0].textContent||'').trim() : '';
          if (code && code === wantCode) { r.click(); return true; }
        }
      }
      return false;
    })(${JSON.stringify(want)})
  `).catch(() => false);
}

// Mở F9 + gõ value → ÉP search lọc đúng value rồi mới đọc option (poll tới khi có).
async function openF9AndType(page, selector, value, { timeout = 12000 } = {}) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.evaluate(`
    (function(sel){
      const el = document.querySelector(sel);
      if (!el) return;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus(); el.click(); el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })(${JSON.stringify(selector)})
  `);
  await pressKey(page, "F9");
  await sleep(300);
  await setAutocompleteText(page, selector, value);

  // Mỗi vòng: ép PrimeFaces search đúng value đã gõ → chờ panel LỌC + tải xong →
  // đọc option. Poll tới khi có (danh sách cấp con có thể tải trễ qua AJAX cấp cha).
  const deadline = Date.now() + timeout;
  let opts = [];
  while (Date.now() < deadline) {
    await triggerPrimeFacesAutocompleteSearch(page, selector);
    await sleep(800);
    opts = await readAutocompleteOptions(page);
    if (opts.length) break;
  }
  return opts;
}

// Dò field con có chứa giá trị cần điền không (không click, xóa lại sau khi dò).
async function probeChildHasValue(page, childSelector, childValue) {
  try {
    const opts = await openF9AndType(page, childSelector, childValue, { timeout: 6000 });
    const target = normalizeVasName(childValue);
    const found = opts.some(function (o) {
      const n = normalizeVasName(o.name);
      return n === target || n.startsWith(target + " ");
    });
    await page.evaluate(`
      (function(sel){ const el=document.querySelector(sel); if(el){ el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } })(${JSON.stringify(childSelector)})
    `).catch(() => {});
    return found;
  } catch {
    return false;
  }
}

// Đọc giá trị hiện tại của ô F9.
async function readInputValue(page, selector) {
  return page
    .evaluate(`(document.querySelector(${JSON.stringify(selector)}) || {}).value || ''`)
    .catch(() => "");
}

// Điền 1 cấp địa chỉ; nếu trùng tên nhiều bản → chọn bản mà field CON chứa giá trị cần điền.
// Sau khi chọn xong ô hiển thị MÃ (khác chữ đã gõ) → dùng để XÁC NHẬN đã chọn, chưa được thì thử lại.
async function fillF9Disambiguated(page, selector, value, label, childSelector, childValue) {
  if (!value) {
    console.log(`    - ${label}: empty, skip.`);
    return;
  }
  const target = normalizeVasName(value);

  // Đã chọn xong khi ô có giá trị và giá trị đó KHÁC chữ đã gõ (đã đổi thành mã).
  const isSelected = async () => {
    const v = String(await readInputValue(page, selector)).trim();
    return !!v && normalizeVasName(v) !== target;
  };

  const pick = async (cand) => {
    if (cand && cand.code && (await clickAutocompleteOptionByCode(page, cand.code))) return true;
    return tryClickFirstAutocompleteOption(page, 5000);
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const opts = await openF9AndType(page, selector, value);
    if (!opts.length) {
      if (attempt >= 3) throw new Error(`No autocomplete option for ${label}: ${value}`);
      await sleep(600);
      continue;
    }

    const candidates = opts.filter((o) => normalizeVasName(o.name) === target);

    // Trùng tên ≥2 bản + có con để phân biệt → dò con.
    if (candidates.length >= 2 && childSelector && childValue) {
      console.log(`    ~ ${label} "${value}" có ${candidates.length} bản trùng tên — dò theo con "${childValue}"...`);
      let matched = null;
      for (const cand of candidates) {
        await openF9AndType(page, selector, value);
        if (!(await clickAutocompleteOptionByCode(page, cand.code))) continue;
        await sleep(T.ajax_wait);
        if (!(await isSelected())) continue; // click chưa ăn → bỏ
        if (await probeChildHasValue(page, childSelector, childValue)) {
          matched = cand;
          break;
        }
        console.log(`      • mã ${cand.code} không chứa con, thử bản khác...`);
      }
      if (matched) {
        console.log(`    ok ${label}: ${value} (mã ${matched.code} — khớp con)`);
        return;
      }
      // không bản nào khớp con → chọn bản đầu bên dưới
    }

    // 0/1 bản (hoặc dò con không ra) → chọn bản khớp tên / option đầu, rồi XÁC NHẬN.
    await pick(candidates[0]);
    await sleep(T.ajax_wait);
    if (await isSelected()) {
      console.log(`    ok ${label}: ${value}`);
      return;
    }
    console.log(`    ~ ${label} "${value}" chọn chưa ăn — thử lại (${attempt}/3)...`);
    await sleep(600);
  }
  throw new Error(`No autocomplete option for ${label}: ${value}`);
}

async function fillF9Autocomplete(page, selector, value, label) {
  if (!value) {
    console.log(`    - ${label}: empty, skip.`);
    return;
  }
  const target = normalizeVasName(value);
  const isSelected = async () => {
    const v = String(await readInputValue(page, selector)).trim();
    return !!v && normalizeVasName(v) !== target;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    const opts = await openF9AndType(page, selector, value);
    if (!opts.length) {
      if (attempt >= 3) throw new Error(`No autocomplete option for ${label}: ${value}`);
      await sleep(600);
      continue;
    }
    // Ưu tiên click theo mã của option khớp tên; fallback click option đầu (tươi).
    const c = opts.filter((o) => normalizeVasName(o.name) === target)[0];
    if (!(c && c.code && (await clickAutocompleteOptionByCode(page, c.code)))) {
      await tryClickFirstAutocompleteOption(page, 5000);
    }
    await sleep(T.ajax_wait);
    if (await isSelected()) {
      console.log(`    ok ${label}: ${value}`);
      return;
    }
    console.log(`    ~ ${label} "${value}" chọn chưa ăn — thử lại (${attempt}/3)...`);
    await sleep(600);
  }
  throw new Error(`No autocomplete option for ${label}: ${value}`);
}

async function fillBccsAddressPopup(page, config, address) {
  console.log(`    [BCCS] Fill address popup: ${config.label}`);

  await openBccsAddressPopup(page, config);
  await sleep(T.ajax_wait);
  await verifyAddressPopupElements(page, config);

  // Con của mỗi cấp (để phân biệt khi trùng tên): Tỉnh→Huyện(hoặc Xã), Huyện→Xã, Xã→Tổ.
  const hasDistrict = !!(config.district && address.district);
  const provChildSel = hasDistrict ? config.district : config.precinct;
  const provChildVal = hasDistrict ? address.district : address.precinct;

  await fillF9Disambiguated(page, config.province, address.province, "Tinh/TP", provChildSel, provChildVal);
  if (hasDistrict) {
    await fillF9Disambiguated(page, config.district, address.district, "Quan/Huyen", config.precinct, address.precinct);
  }
  await fillF9Disambiguated(page, config.precinct, address.precinct, "Phuong/Xa", config.groupStreet, address.groupStreet);
  await fillF9Autocomplete(page, config.groupStreet, address.groupStreet, "To/Thon");

  if (config.street && address.street) {
    await safeFill(page, config.street, address.street);
  }
  if (config.noApartment && address.noApartment) {
    // Không bắt buộc — selector Số nhà có thể khác; lỗi thì cảnh báo, không phá luồng.
    try {
      await safeFill(page, config.noApartment, address.noApartment);
      console.log(`    ✅ Số nhà: ${address.noApartment}`);
    } catch (e) {
      console.warn(`    ⚠️  Không điền được Số nhà (${config.noApartment}): ${e.message}`);
    }
  }

  await pressKey(page, "F8");
  await sleep(500);

  const savedByButton = await page.evaluate(`
    (function(sel) {
      const btn = document.querySelector(sel);
      if (!btn) return false;
      btn.click();
      return true;
    })(${JSON.stringify(config.saveButton)})
  `).catch(() => false);

  if (!savedByButton) {
    console.warn(`    Address save button not found, relying on F8 only: ${config.saveButton}`);
  }
  await sleep(4000);
}

async function verifyAddressPopupElements(page, config) {
  const required = [
    ["province", config.province],
    ...(config.district ? [["district", config.district]] : []),
    ["precinct", config.precinct],
    ["groupStreet", config.groupStreet],
    ...(config.street ? [["street", config.street]] : []),
    // noApartment (Số nhà) KHÔNG bắt buộc — selector có thể khác giữa popup
    // billing/billingNew; thiếu thì bỏ qua, không chặn cả luồng.
    ["saveButton", config.saveButton],
  ];

  const missing = [];
  for (const [name, selector] of required) {
    const exists = await page.evaluate(`
      !!document.querySelector(${JSON.stringify(selector)})
    `).catch(() => false);
    if (!exists) missing.push(`${name}: ${selector}`);
  }

  if (missing.length) {
    throw new Error(`Address popup missing elements: ${missing.join(" | ")}`);
  }
  console.log(`    Address popup elements ready: ${config.label}`);
}

async function isAddressDialogOpen(page, selector) {
  return page.evaluate(`
    (function(sel) {
      const el = document.querySelector(sel);
      if (!el) return false;

      const st = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const ariaHidden = el.getAttribute('aria-hidden');

      return ariaHidden === 'false'
        || (st.display !== 'none' && st.visibility !== 'hidden' && rect.width > 0 && rect.height > 0);
    })(${JSON.stringify(selector)})
  `).catch(() => false);
}

async function waitForAddressDialogOpen(page, selector, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isAddressDialogOpen(page, selector)) return true;
    await sleep(300);
  }
  return false;
}

async function openBccsAddressPopup(page, config) {
  await page.waitForSelector(config.openInput, { timeout: 10000 });

  if (await waitForAddressDialogOpen(page, config.dialog, 800)) {
    console.log(`    Address popup already open: ${config.label}`);
    return;
  }

  const openedByFunction = await page.evaluate(`
    (function() {
      const fnName = ${JSON.stringify(config.openFunction || "")};
      if (fnName && typeof window[fnName] === 'function') {
        window[fnName]();
        return true;
      }
      return false;
    })()
  `).catch(() => false);

  console.log(
    `    Address popup open attempt: ${openedByFunction ? "function:" + config.openFunction : "no-function"}`
  );
  if (await waitForAddressDialogOpen(page, config.dialog, 20000)) return;

  const openedByInput = await page.evaluate(`
    (function() {
      const sel = ${JSON.stringify(config.openInput)};
      const el = document.querySelector(sel);
      if (!el) return false;

      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.focus();
      el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      return true;
    })()
  `).catch(() => false);

  console.log(`    Address popup open attempt: ${openedByInput ? "focus-click" : "input-not-found"}`);
  if (await waitForAddressDialogOpen(page, config.dialog, 20000)) return;

  const debug = await page.evaluate(`
    (function(sel) {
      const el = document.querySelector(sel);
      if (!el) return { exists: false };
      const st = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        exists: true,
        ariaHidden: el.getAttribute('aria-hidden'),
        display: st.display,
        visibility: st.visibility,
        width: rect.width,
        height: rect.height,
        className: el.className,
      };
    })(${JSON.stringify(config.dialog)})
  `).catch(err => ({ error: err.message }));

  throw new Error(`Address dialog did not open: ${config.dialog} | ${JSON.stringify(debug)}`);
}

function splitStreetAndHouseNo(value) {
  const raw = String(value || "").trim();
  if (!raw) return { street: "", noApartment: "" };

  const match = raw.match(/^([0-9A-Za-z][0-9A-Za-z./-]*)\s+(.+)$/);
  if (!match) return { street: raw, noApartment: "" };

  return {
    noApartment: match[1].trim(),
    street: match[2].trim(),
  };
}

function buildOwnerAddressForBccs(masterData, { useShipCodeAsStreet = false } = {}) {
  const streetParts = splitStreetAndHouseNo(masterData.owner_address_street);
  const road = String(masterData.owner_address_road || "").trim();
  const shipCode = String(masterData.ship_code || "").trim();

  let street, noApartment;
  if (useShipCodeAsStreet) {
    // Địa chỉ XM/TBC — Mã tàu luôn có mặt:
    //  - KHÔNG có tên Đường → Đường/phố = Mã tàu, Số nhà để trống.
    //  - CÓ tên Đường       → Đường/phố = tên đường, Số nhà = Mã tàu.
    if (road) {
      street = road;
      noApartment = shipCode;
    } else {
      street = shipCode;
      noApartment = "";
    }
  } else {
    street = streetParts.street;
    noApartment = streetParts.noApartment;
  }

  return {
    province: masterData.owner_address_province,
    district: masterData.owner_address_district,
    precinct: masterData.owner_address_precinct,
    groupStreet: masterData.owner_address_group_street,
    street,
    noApartment,
  };
}

function hasRequiredBccsAddress(address, { requireDistrict = false } = {}) {
  return Boolean(
    address?.province &&
    (!requireDistrict || address.district) &&
    address?.precinct &&
    address?.groupStreet
  );
}

async function fillDatePicker(page, selector, ddmmyyyy) {
  // Láº¥y digits, yÃªu cáº§u Ã­t nháº¥t 8 sá»‘ (ddmmyyyy)
  const digits = String(ddmmyyyy || "").replace(/\D/g, "");
  if (!digits || digits.length < 8) return;

  // Format thÃ nh DD/MM/YYYY â€” PrimeFaces calendar nháº­n format nÃ y
  const formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;

  await page.waitForSelector(selector, { timeout: 10000 });
  // Set value trá»±c tiáº¿p qua JS â€” trÃ¡nh bug typeText vá»›i PrimeFaces datepicker
  // Gõ từng số bị mask xáo trộn thứ tự → set value đúng rồi ĐÓNG lịch (không che field khác).
  await page.evaluate(`
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      el.focus();
      el.value = ${JSON.stringify(formatted)};
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try { if (window.jQuery && window.jQuery.datepicker) window.jQuery.datepicker._hideDatepicker(); } catch (e) {}
      el.blur();
      document.body.click();
    })()
  `);
  await sleep(T.after_fill);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Launch SFive + Connect CDP
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function launchSFive() {
  if (!fs.existsSync(BCCS_SFIVE_PATH)) {
    throw new Error(
      `KhÃ´ng tÃ¬m tháº¥y SFive táº¡i: ${BCCS_SFIVE_PATH}\n` +
      `Kiá»ƒm tra BCCS_SFIVE_PATH trong .env`
    );
  }

  console.log(`  ðŸ¦Š [BCCS] Khá»Ÿi Ä‘á»™ng SFive: ${BCCS_SFIVE_PATH}`);

  // ÄÃ³ng SFive Ä‘ang cháº¡y (náº¿u cÃ³) Ä‘á»ƒ trÃ¡nh conflict port
  try {
    execSync("taskkill /f /im sfive.exe", { stdio: "ignore" });
    console.log(`  ðŸ”„ [BCCS] ÄÃ£ Ä‘Ã³ng SFive cÅ©.`);
    await sleep(1500);
  } catch { /* KhÃ´ng cÃ³ SFive â†’ bá» qua */ }

  const proc = spawn(
    BCCS_SFIVE_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-infobars",
      "--disable-session-crashed-bubble",
      "--disable-translate",
      "--disable-features=TranslateUI",
    ],
    { detached: true, stdio: "ignore" }
  );
  proc.unref();

  console.log(`  â³ [BCCS] Chá» SFive khá»Ÿi Ä‘á»™ng (4s)...`);
  await sleep(4000);
}

async function connectCDP() {
  console.log(`  ðŸ”Œ [BCCS] Káº¿t ná»‘i CDP port ${CDP_PORT}...`);
  CDP ??= require("chrome-remote-interface");
  for (let i = 1; i <= 15; i++) {
    try {
      const client = await CDP({ port: CDP_PORT });
      console.log(`  âœ… [BCCS] Káº¿t ná»‘i CDP thÃ nh cÃ´ng (láº§n thá»­ ${i}).`);
      return client;
    } catch {
      if (i < 15) await sleep(1000);
    }
  }
  throw new Error(
    `KhÃ´ng thá»ƒ káº¿t ná»‘i CDP Ä‘áº¿n SFive (port ${CDP_PORT}).\n` +
    `SFive Ä‘Ã£ khá»Ÿi Ä‘á»™ng vá»›i --remote-debugging-port chÆ°a?`
  );
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LOGIN
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function dismissChromePopups(page) {
  console.log(`  [BCCS] Don popup Chrome/SFive neu co...`);
  for (let i = 0; i < 8; i++) {
    try {
      await pressKey(page, "Esc");
    } catch (err) {
      console.warn(`  [BCCS] Khong the bam Esc de don popup: ${err.message}`);
      return;
    }
    await sleep(500);
  }
}

async function login(page) {
  console.log(`\n  ðŸ” [BCCS] Má»Ÿ trang Ä‘Äƒng nháº­p â€” ${BCCS_LOGIN_URL}`);
  await page.goto(BCCS_LOGIN_URL, { timeout: 20000 });
  await sleep(T.page_load);

  // Äiá»n username
  for (const sel of SEL_LOGIN_USER) {
    try {
      const cur = await page.evaluate(`(function(s){const e=document.querySelector(s);return e?(e.value||'').trim():'';})(${JSON.stringify(sel)})`).catch(() => '');
      if (!cur) { await page.fill(sel, BCCS_USERNAME, { timeout: 3000 }); console.log('  - Username: dien tu .env.'); }
      else console.log('  - Username: da co san (' + cur + ') -> giu nguyen.');
      break;
    }
    catch { /* thá»­ selector tiáº¿p */ }
  }

  // Äiá»n password
  for (const sel of SEL_LOGIN_PASS) {
    try {
      const cur = await page.evaluate(`(function(s){const e=document.querySelector(s);return e?(e.value||'').trim():'';})(${JSON.stringify(sel)})`).catch(() => '');
      if (!cur) { await page.fill(sel, BCCS_PASSWORD, { timeout: 3000 }); console.log('  - Password: dien tu .env.'); }
      else console.log('  - Password: da co san -> giu nguyen.');
      break;
    }
    catch { /* thá»­ selector tiáº¿p */ }
  }

  // Click ÄÄƒng nháº­p â€” setup nav listener TRÆ¯á»šC khi click
  const navPromise = page.waitForNavigation({ timeout: 15000 }).catch(() => {});
  let clicked = false;
  for (const sel of SEL_LOGIN_BTN) {
    try {
      await page.click(sel, { timeout: 3000 });
      clicked = true;
      break;
    } catch { /* thá»­ selector tiáº¿p */ }
  }

  if (!clicked) {
    // Fallback: tÃ¬m button báº±ng text
    try {
      await page.evaluate(`
        (function() {
          const btns = document.querySelectorAll('button, input[type=submit], a');
          for (const b of btns) {
            if (b.textContent?.trim().includes('ÄÄ‚NG NHáº¬P') ||
                b.value?.includes('ÄÄ‚NG NHáº¬P')) {
              b.click(); return;
            }
          }
        })()
      `);
      clicked = true;
    } catch {}
  }

  if (!clicked) console.warn(`  âš ï¸  [BCCS] KhÃ´ng click Ä‘Æ°á»£c nÃºt Ä‘Äƒng nháº­p.`);

  // Chá» SSO redirect (passport â†’ BCCS)
  console.log(`  â³ [BCCS] Chá» SSO redirect...`);
  await navPromise;
  await page.waitForURLContains("SALE_WEB", { timeout: 20000 }).catch(() => {});
  await sleep(T.page_load);
  console.log(`  âœ… [BCCS] ÄÃ£ Ä‘Äƒng nháº­p â€” URL: ${page.url()}`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// NAVIGATION
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function navigateToStracking(page) {
  console.log(`\n  ðŸ”— [BCCS] Äiá»u hÆ°á»›ng Ä‘áº¿n Stracking â€” ${BCCS_ENTRY_URL}`);
  await page.goto(BCCS_ENTRY_URL, { timeout: 20000 });
  await sleep(3000); // chá» PrimeFaces JSF init xong
  console.log(`  âœ… [BCCS] Trang Stracking Ä‘Ã£ load â€” URL: ${page.url()}`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 1: THÃ”NG TIN KHÃCH HÃ€NG
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function fillCustomerSection(page, masterData) {
  console.log(`\n  ðŸ‘¤ [BCCS] Äiá»n thÃ´ng tin khÃ¡ch hÃ ng...`);

  // â”€â”€ BÆ¯á»šC 1: Äiá»n sá»‘ CCCD trÆ°á»›c â€” gÃµ tá»«ng kÃ½ tá»± cháº­m â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let autoFilled = false;

  if (masterData.owner_cccd) {
    console.log(`    â€¢ Sá»‘ CCCD: ${masterData.owner_cccd}`);
    // Chá» form render láº§n Ä‘áº§u (JSF cháº­m sau SSO)
    await page.waitForSelector(SEL_ID_NUMBER, { timeout: T.form_ready });
    // GÃµ tá»«ng sá»‘ cháº­m â€” cursor á»Ÿ láº¡i field Ä‘á»ƒ BCCS ká»‹p hiá»‡n dropdown
    await page.typeSlowly(SEL_ID_NUMBER, String(masterData.owner_cccd));

    // Chá» 2s Ä‘á»ƒ dropdown autocomplete hiá»‡n ra
    console.log(`    â³ Chá» 2s Ä‘á»ƒ dropdown hiá»‡n ra...`);
    await sleep(2000);

    try {
      await page.waitForSelector(SEL_CCCD_RESULT, { timeout: 1000 });
      await page.click(SEL_CCCD_RESULT);
      // Chá» 6s Ä‘á»ƒ BCCS tá»± Ä‘iá»n toÃ n bá»™ thÃ´ng tin KH
      console.log(`    â³ Chá» 6s BCCS tá»± Ä‘iá»n thÃ´ng tin KH...`);
      await sleep(6000);
      console.log(`    âœ… TÃ¬m tháº¥y KH â€” BCCS Ä‘Ã£ tá»± Ä‘iá»n toÃ n bá»™. Bá» qua cÃ¡c trÆ°á»ng cÃ²n láº¡i.`);
      autoFilled = true;
    } catch {
      console.log(`    â„¹ï¸  KhÃ´ng tÃ¬m tháº¥y KH trong dropdown â€” sáº½ Ä‘iá»n thá»§ cÃ´ng.`);
    }
  }

  // â”€â”€ Náº¿u BCCS Ä‘Ã£ tá»± Ä‘iá»n â†’ dá»«ng háº³n, khÃ´ng cáº§n Ä‘iá»n gÃ¬ thÃªm â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (autoFilled) {
    console.log(`    â­ï¸  Bá» qua toÃ n bá»™ ThÃ´ng tin khÃ¡ch hÃ ng (Ä‘Ã£ auto-fill).`);
    return;
  }

  // â”€â”€ BÆ¯á»šC 2: Äiá»n thá»§ cÃ´ng khi khÃ´ng cÃ³ káº¿t quáº£ dropdown â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Loáº¡i giáº¥y tá»
  const cccd   = String(masterData.owner_cccd || "").replace(/\D/g, "");
  const idType = cccd.length === 9  ? "Chá»©ng minh nhÃ¢n dÃ¢n"
               : cccd.length === 12 ? "Tháº» cÄƒn cÆ°á»›c"
               : null;
  if (idType) {
    console.log(`    â€¢ Loáº¡i giáº¥y tá»: "${idType}" (${cccd.length} sá»‘)`);
    try {
      await page.waitForSelector(SEL_ID_TYPE, { timeout: 8000 });
      try {
        await page.selectOption(SEL_ID_TYPE, { label: idType });
      } catch {
        await page.selectOption(SEL_ID_TYPE, { index: cccd.length === 9 ? 1 : 2 });
      }
      // Chọn Loại giấy tờ vừa render lại → XÓA ô CCCD. Chờ AJAX rồi gõ lại số CCCD.
      try {
        await sleep(T.ajax_wait);
        await page.typeSlowly(SEL_ID_NUMBER, cccd);
      } catch (e) {
        console.warn(`    ⚠️  Gõ lại số CCCD thất bại: ${e.message}`);
      }
    } catch (err) {
      console.warn(`    âš ï¸  Loáº¡i giáº¥y tá» â€” tháº¥t báº¡i: ${err.message}`);
    }
  }

  // NgÃ y cáº¥p
  if (masterData.issue_date) {
    console.log(`    â€¢ NgÃ y cáº¥p: ${masterData.issue_date}`);
    try { await fillDatePicker(page, SEL_ISSUE_DATE, masterData.issue_date); }
    catch (err) { console.warn(`    âš ï¸  NgÃ y cáº¥p â€” tháº¥t báº¡i: ${err.message}`); }
  }

  // NÆ¡i cáº¥p
  const NOI_CAP_DEFAULT = "Cá»¥c TrÆ°á»Ÿng CCS QLHC Vá» Tráº­t Tá»± XÃ£ Há»™i";
  const noiCap = masterData.issue_place || NOI_CAP_DEFAULT;
  // Ngày cấp có onchange render lại ô Nơi cấp (@([id$=mainCustomertxtPlaceIss]))
  // → chờ AJAX xong rồi mới điền, tránh bị ghi đè trống.
  await sleep(T.ajax_wait);
  console.log(`    â€¢ NÆ¡i cáº¥p: "${noiCap}"`);
  try { await sleep(30); /* Nơi cấp điền ở cuối hàm */ }
  catch (err) { console.warn(`    âš ï¸  NÆ¡i cáº¥p â€” tháº¥t báº¡i: ${err.message}`); }

  // TÃªn khÃ¡ch hÃ ng
  if (masterData.owner_name) {
    console.log(`    â€¢ TÃªn KH: ${masterData.owner_name}`);
    try { await safeFill(page, SEL_OWNER_NAME, masterData.owner_name); }
    catch (err) { console.warn(`    âš ï¸  TÃªn KH â€” tháº¥t báº¡i: ${err.message}`); }
  }

  // NgÃ y sinh
  if (masterData.owner_birthday) {
    console.log(`    â€¢ NgÃ y sinh: ${masterData.owner_birthday}`);
    try { await fillDatePicker(page, SEL_BIRTHDAY, masterData.owner_birthday); }
    catch (err) { console.warn(`    âš ï¸  NgÃ y sinh â€” tháº¥t báº¡i: ${err.message}`); }
  }

  // Giá»›i tÃ­nh
  // Ngày hết hạn = Ngày sinh + 100 năm (vd 26/03/2004 → 26/03/2104).
  if (masterData.owner_birthday) {
    const parts = String(masterData.owner_birthday).split(/\D+/).filter(Boolean);
    if (parts.length === 3 && parts[2].length === 4) {
      const dd = parts[0].padStart(2, "0");
      const mm = parts[1].padStart(2, "0");
      const expire = `${dd}/${mm}/${parseInt(parts[2], 10) + 100}`;
      console.log(`    • Ngày hết hạn: ${expire}`);
      try { await fillDatePicker(page, SEL_EXPIRE_DATE, expire); }
      catch (err) { console.warn(`    ⚠️  Ngày hết hạn — thất bại: ${err.message}`); }
    }
  }

  const gender = String(masterData.vessel_owner_gender || "").toUpperCase();
  if (gender === "T" || gender === "G") {
    const sel = gender === "T" ? SEL_GENDER_NAM : SEL_GENDER_NU;
    console.log(`    â€¢ Giá»›i tÃ­nh: ${gender === "T" ? "Nam" : "Ná»¯"}`);
    try {
      await page.waitForSelector(sel, { timeout: 8000, state: "attached" });
      await page.click(sel, { force: true });
    } catch (err) { console.warn(`    âš ï¸  Giá»›i tÃ­nh â€” tháº¥t báº¡i: ${err.message}`); }
  }

  // Noi cap: DIEN CUOI CUNG (sau Ngay cap/Ngay sinh) de khong bi AJAX render lai xoa.
  await sleep(T.ajax_wait);
  console.log(`    • Nơi cấp (điền cuối): "${noiCap}"`);
  try { await safeFill(page, SEL_ISSUE_PLACE, noiCap); }
  catch (e) { console.warn(`    ⚠️  Nơi cấp — thất bại: ${e.message}`); }

  // Dia chi khach hang — mo modal + dien (giong dia chi lap dat). Loi thi log, khong chan luong.
  try {
    const ownerAddr = buildOwnerAddressForBccs(masterData);
    if (hasRequiredBccsAddress(ownerAddr, { requireDistrict: false })) {
      await fillBccsAddressPopup(page, ADDRESS_POPUPS.customer, ownerAddr);
    } else {
      console.log(`    Dia chi KH — thieu du lieu, bo qua.`);
    }
  } catch (e) {
    console.warn(`    Dia chi KH — that bai: ${e.message}`);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 2: THÃ”NG TIN Sáº¢N PHáº¨M
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function fillPackageSection(page, masterData) {
  console.log(`\n  ðŸ“¦ [BCCS] Äiá»n thÃ´ng tin sáº£n pháº©m...`);

  const PACKAGE_CODE = "STRMF385";
  try {
    await page.waitForSelector(SEL_PACKAGE_INPUT);
    await page.click(SEL_PACKAGE_INPUT);
    await page.fill(SEL_PACKAGE_INPUT, PACKAGE_CODE);
    await sleep(T.dropdown);

    const DROPDOWN = ".ui-autocomplete-item, .ui-autocomplete-list-item";
    try {
      await page.waitForSelector(DROPDOWN, { timeout: 5000 });
      await page.click(DROPDOWN);
    } catch {
      // Fallback: Enter Ä‘á»ƒ xÃ¡c nháº­n náº¿u khÃ´ng cÃ³ dropdown
      await page.evaluate(`
        document.querySelector(${JSON.stringify(SEL_PACKAGE_INPUT)})
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
      `);
    }
    // Chá» 7s Ä‘á»ƒ cÃ¡c radio chá»n sá»‘ thÃ¡ng render sau khi chá»n gÃ³i cÆ°á»›c
    console.log(`    â³ Chá» 7s Ä‘á»ƒ radio sá»‘ thÃ¡ng hiá»‡n ra...`);
    await sleep(7000);
    console.log(`    âœ… GÃ³i cÆ°á»›c: ${PACKAGE_CODE}`);
  } catch (err) {
    console.warn(`    âš ï¸  GÃ³i cÆ°á»›c â€” tháº¥t báº¡i: ${err.message}`);
    return; // khÃ´ng cÃ³ gÃ³i cÆ°á»›c â†’ radio khÃ´ng render, dá»«ng
  }

  // â”€â”€ Duration radio â€” so sÃ¡nh chÃ­nh xÃ¡c: 12 / 6 / 3 thÃ¡ng â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const months = Number(masterData.so_thang) || 0;

  // radioBoxSel = div .ui-radiobutton-box bÃªn trong panel (visible, PrimeFaces JS láº¯ng nghe)
  // btnSel      = button áº©n optCommand0N (onclick â†’ PrimeFaces.ab() cáº­p nháº­t form sections)
  // inputSel    = hidden radio input (onchange â†’ PrimeFaces.ab() + selectRadio())
  const radioMap = [
    {
      val:         12,
      panelSel:    '[id="connectForm:panelListRealtion01"]',
      radioBoxSel: '[id="connectForm:panelListRealtion01"] .ui-radiobutton-box',
      btnSel:      '[id="connectForm:optCommand01"]',
      inputSel:    '[id="connectForm:customRadio0:1_clone"]',
      label:       "12 thÃ¡ng",
    },
    {
      val:         6,
      panelSel:    '[id="connectForm:panelListRealtion02"]',
      radioBoxSel: '[id="connectForm:panelListRealtion02"] .ui-radiobutton-box',
      btnSel:      '[id="connectForm:optCommand02"]',
      inputSel:    '[id="connectForm:customRadio0:2_clone"]',
      label:       "6 thÃ¡ng",
    },
    {
      val:         3,
      panelSel:    '[id="connectForm:panelListRealtion03"]',
      radioBoxSel: '[id="connectForm:panelListRealtion03"] .ui-radiobutton-box',
      btnSel:      '[id="connectForm:optCommand03"]',
      inputSel:    '[id="connectForm:customRadio0:3_clone"]',
      label:       "3 thÃ¡ng",
    },
  ];

  const radio = radioMap.find(r => months === r.val);
  if (radio) {
    console.log(`    â€¢ Chu ká»³: ${months} thÃ¡ng â†’ chá»n ${radio.label}`);
    try {
      // 1. Chá» panel render
      await page.waitForSelector(radio.panelSel, { timeout: 8000 });

      // 2. Click .ui-radiobutton-box â€” PrimeFaces JS nháº­n click á»Ÿ Ä‘Ã¢y,
      //    tá»± set checked + trigger onchange trÃªn hidden input
      await page.evaluate(
        `document.querySelector(${JSON.stringify(radio.radioBoxSel)}).click()`
      );
      await sleep(600);

      // 3. Force-click hidden button optCommand0N â€” trigger PrimeFaces.ab()
      //    cáº­p nháº­t cÃ¡c section: mainSubGoodsPanel, commonInfo, sealingCode â€¦
      await page.evaluate(
        `document.querySelector(${JSON.stringify(radio.btnSel)}).click()`
      );
      console.log(`    ⏳ Chờ 7s sau khi chọn ${radio.label}...`);
      await sleep(7000);

      console.log(`    âœ… ÄÃ£ chá»n chu ká»³ ${radio.label}`);
    } catch (err) {
      console.warn(`    âš ï¸  Radio ${radio.label} â€” tháº¥t báº¡i: ${err.message}`);
    }
  } else {
    console.log(`    â­ï¸  Bá» qua radio â€” so_thang = ${masterData.so_thang} (khÃ´ng pháº£i 3/6/12)`);
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 3: THÃ”NG TIN THUÃŠ BAO
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Chon 1 PrimeFaces SelectOneMenu trong bang subgoods theo TEXT cua option
// (selectSel = CSS selector cua the <select> an ben trong widget).
async function selectSubGoodsMenuByText(page, selectSel, textIncludes) {
  await page.waitForSelector(selectSel, { timeout: 8000, state: "attached" });
  const result = await page.evaluate(`
    (function(sel, needle) {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: 'not-found' };
      const want = needle.toLowerCase();
      const opt = Array.from(el.options || [])
        .find(o => (o.textContent || '').toLowerCase().includes(want));
      if (!opt) return { ok: false, reason: 'option-not-found' };
      el.value = opt.value;
      opt.selected = true;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (el.id && el.id.endsWith('_input')) {
        const lbl = document.getElementById(el.id.slice(0, -6) + '_label');
        if (lbl) lbl.textContent = (opt.textContent || '').trim();
      }
      return { ok: true, label: (opt.textContent || '').trim() };
    })(${JSON.stringify(selectSel)}, ${JSON.stringify(textIncludes)})
  `);
  if (!result?.ok) {
    throw new Error(`select ${selectSel} ~ "${textIncludes}" failed: ${result?.reason || "unknown"}`);
  }
  return result;
}

// Dien muc "Danh sach thiet bi kem theo" (moi cua BCCS):
//   Thiet bi -> S-Tracking V03 | Hinh thuc cung cap -> Ban dut | Serial -> serial_number.
// Neu bang chua render thi bo qua an toan.
async function fillSubGoodsSection(page, masterData) {
  try {
    await page.waitForSelector(SEL_SUBGOODS_SERIAL, { timeout: 5000, state: "attached" });
  } catch {
    console.log('    Bo qua "Danh sach thiet bi kem theo" (khong thay bang).');
    return;
  }

  console.log(`\n  [BCCS] Dien "Danh sach thiet bi kem theo"...`);

  try {
    const r = await selectSubGoodsMenuByText(page, SEL_SUBGOODS_DEVICE, SUBGOODS_DEVICE_TEXT);
    console.log(`    - Thiet bi: ${r.label}`);
    await sleep(T.ajax_wait);
  } catch (err) { console.warn(`    Thiet bi failed: ${err.message}`); }

  try {
    const r = await selectSubGoodsMenuByText(page, SEL_SUBGOODS_SUPPLY, SUBGOODS_SUPPLY_TEXT);
    console.log(`    - Hinh thuc cung cap: ${r.label}`);
    await sleep(T.ajax_wait);
  } catch (err) { console.warn(`    Hinh thuc cung cap failed: ${err.message}`); }

  if (masterData.serial_number) {
    try {
      await safeFill(page, SEL_SUBGOODS_SERIAL, masterData.serial_number);
      await page.evaluate(`
        (function(sel) {
          const el = document.querySelector(sel);
          if (!el) return;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        })(${JSON.stringify(SEL_SUBGOODS_SERIAL)})
      `);
      console.log(`    - Serial: ${masterData.serial_number}`);
    } catch (err) { console.warn(`    Serial (subgoods) failed: ${err.message}`); }
  }
}

async function fillSubscriberSection(page, masterData) {
  console.log(`\n  ðŸ“¡ [BCCS] Äiá»n thÃ´ng tin thuÃª bao...`);

  // Ma mat hang: key nam o ky tu 6-9 cua serial.
  // 2025 -> go 2025, chon option dau tien.
  // 2019 -> go 7000, chon dung option GPDN_STRACKING_7000.
  try {
    const serialNumber = String(masterData.serial_number || "").trim();
    const serialKey = serialNumber.slice(5, 9);
    const productSearch = serialKey === "2019" ? "7000" : (serialKey || "2025");
    const preferredOption = serialKey === "2019" ? "GPDN_STRACKING_7000" : "";

    await page.waitForSelector(SEL_SUB_TYPE, { timeout: 10000 });
    console.log(`    - Ma mat hang: serialKey=${serialKey || "N/A"}, go "${productSearch}"...`);
    await safeFill(page, SEL_SUB_TYPE, "");
    await page.typeSlowly(SEL_SUB_TYPE, productSearch);
    await sleep(T.dropdown);

    const MAH_DROP = '.ui-autocomplete-panel .ui-autocomplete-item, .ui-autocomplete-panel li.ui-autocomplete-item, .ui-autocomplete-panel tr.ui-widget-content';
    try {
      await page.waitForSelector(MAH_DROP, { timeout: 3000 });
      const selectedByText = preferredOption
        ? await clickAutocompleteOptionByText(page, preferredOption, 3000)
        : false;
      if (!selectedByText) {
        await page.click(MAH_DROP);
      }
      await sleep(T.ajax_wait);
      console.log(`    - Ma mat hang da chon${preferredOption ? `: ${preferredOption}` : "."}`);
    } catch {
      // Fallback: Enter náº¿u khÃ´ng cÃ³ dropdown
      await page.evaluate(`
        document.querySelector('[id="connectForm:cbxProductOffering_input"]')
          ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }))
      `);
      await sleep(T.ajax_wait);
      console.log(`    âœ… MÃ£ máº·t hÃ ng: Enter fallback.`);
    }
  } catch (err) { console.warn(`    âš ï¸  MÃ£ máº·t hÃ ng â€” tháº¥t báº¡i: ${err.message}`); }

  // â”€â”€ ThÃ´ng tin serial thiáº¿t bá»‹ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (masterData.serial_number) {
    console.log(`    â€¢ Serial: ${masterData.serial_number}`);
    try {
      // Chá» field render (cÃ³ thá»ƒ xuáº¥t hiá»‡n sau khi chá»n mÃ£ máº·t hÃ ng)
      await page.waitForSelector(SEL_SERIAL, { timeout: 8000 });
      await safeFill(page, SEL_SERIAL, masterData.serial_number);
      await page.evaluate(`
        (function(sel) {
          const el = document.querySelector(sel);
          if (!el) return;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        })(${JSON.stringify(SEL_SERIAL)})
      `);
    } catch (err) { console.warn(`    âš ï¸  Serial â€” tháº¥t báº¡i: ${err.message}`); }
  }

  if (masterData.bien_so_tau) {
    console.log(`    Bien so tau: ${masterData.bien_so_tau}`);
    try { await safeFill(page, SEL_BIEN_SO, masterData.bien_so_tau); }
    catch (err) { console.warn(`    Bien so tau failed: ${err.message}`); }
  }

  const installAddress = buildOwnerAddressForBccs(masterData);
  if (hasRequiredBccsAddress(installAddress, { requireDistrict: true })) {
    try {
      await fillBccsAddressPopup(page, ADDRESS_POPUPS.install, installAddress);
    } catch (err) {
      throw new Error(`Dia chi lap dat failed: ${err.message}`);
    }
  } else {
    throw new Error("Dia chi lap dat missing province/district/precinct/groupStreet.");
  }

  // Danh sach thiet bi kem theo (muc moi cua BCCS) — dien truoc khi reload ISDN
  await fillSubGoodsSection(page, masterData);

  console.log(`    Reload ISDN last`);
  try {
    await safeClick(page, SEL_RELOAD_ISDN, { wait: T.ajax_wait });
    console.log(`    ISDN reloaded.`);
  } catch (err) { console.warn(`    ISDN reload failed: ${err.message}`); }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 4: THÃ”NG TIN THANH TOÃN
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Má»Ÿ PrimeFaces SelectOneMenu rá»“i click option khá»›p vá»›i optionLabel.
 * Náº¿u khÃ´ng tÃ¬m Ä‘Æ°á»£c theo label â†’ click option Ä‘áº§u tiÃªn khÃ´ng pháº£i placeholder.
 * inputSel: selector cá»§a element _input (visible display label).
 */
async function pfMenuSelect(page, inputSel, optionLabel) {
  // Má»Ÿ dropdown báº±ng cÃ¡ch click vÃ o _input (PrimeFaces má»Ÿ panel khi click)
  await page.evaluate(`document.querySelector(${JSON.stringify(inputSel)}).click()`);
  await sleep(500);

  const result = await page.evaluate(`
    (function(label) {
      // TÃ¬m panel Ä‘ang má»Ÿ (visible)
      const allPanels = document.querySelectorAll('.ui-selectonemenu-panel');
      let panel = null;
      for (const p of allPanels) {
        const st = window.getComputedStyle(p);
        if (st.display !== 'none' && st.visibility !== 'hidden') {
          panel = p; break;
        }
      }
      if (!panel) return 'no-panel';

      const items = panel.querySelectorAll('li.ui-selectonemenu-item');
      // Æ¯u tiÃªn khá»›p label chÃ­nh xÃ¡c
      for (const item of items) {
        const lbl = (item.getAttribute('data-label') || item.textContent || '').trim();
        if (lbl === label) { item.click(); return 'exact:' + lbl; }
      }
      // Fallback: click item Ä‘áº§u tiÃªn khÃ´ng pháº£i placeholder "-- Chá»n giÃ¡ trá»‹ --"
      for (const item of items) {
        const lbl = (item.getAttribute('data-label') || item.textContent || '').trim();
        if (lbl && !lbl.includes('Chá»n') && !lbl.includes('--')) {
          item.click(); return 'first:' + lbl;
        }
      }
      return 'not-found';
    })(${JSON.stringify(optionLabel)})
  `);
  await sleep(T.after_fill);
  return result;
}

async function fillPaymentSection(page, masterData) {
  console.log(`\n  ðŸ’³ [BCCS] Äiá»n thÃ´ng tin thanh toÃ¡n...`);

  // â”€â”€ Chu ká»³ cÆ°á»›c: native select áº©n cá»§a PrimeFaces, chá»n value rá»“i dispatch change â”€â”€
  console.log(`    â€¢ Chu ká»³ cÆ°á»›c...`);
  try {
    const res = await selectOneMenuByClick(page, "svAccountInfo:cbxViewBillCycle", "chu ky cuoc 1");
    console.log(`    âœ… Chu ká»³ cÆ°á»›c: ${res.label}`);
  } catch (err) { console.warn(`    âš ï¸  Chu ká»³ cÆ°á»›c â€” tháº¥t báº¡i: ${err.message}`); }

  // â”€â”€ HÃ¬nh thá»©c TT & TBC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  for (const { label, sel, value } of [
    { label: "HÃ¬nh thá»©c TT",  sel: SEL_PAY_METHOD,    value: "01", pfLabel: "" },
    { label: "HÃ¬nh thá»©c TBC", sel: SEL_NOTICE_CHARGE, value: "2",  pfLabel: "" },
    { label: "In chi tiet cuoc", sel: SEL_PRINT_METHOD, value: "2",  pfLabel: "" },
  ]) {
    console.log(`    â€¢ ${label}`);
    try {
      const res = await selectNativeAndChange(page, sel, value, { wait: T.ajax_wait });
      console.log(`    âœ… ${label}: ${res.label}`);
    } catch (err) {
      console.warn(`    âš ï¸  ${label} â€” tháº¥t báº¡i: ${err.message}`);
    }
  }

  // â”€â”€ Äiá»‡n thoáº¡i â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Chu kỳ cước: chọn LẠI sau các dropdown khác (option "1" có thể chưa sẵn sàng lúc đầu).
  try {
    const res = await selectOneMenuByClick(page, "svAccountInfo:cbxViewBillCycle", "chu ky cuoc 1");
    console.log("    Chu ky cuoc: " + res.label);
  } catch (err) {
    console.warn("    Chu ky cuoc - that bai: " + err.message);
  }

  if (masterData.owner_phone) {
    console.log(`    â€¢ Äiá»‡n thoáº¡i: ${masterData.owner_phone}`);
    try {
      await safeFill(page, SEL_PHONE, masterData.owner_phone);
      // Blur khá»i field sau khi fill Ä‘á»ƒ cursor khÃ´ng á»Ÿ láº¡i
      await page.evaluate(`document.activeElement && document.activeElement.blur()`);
      await sleep(200);
    } catch (err) { console.warn(`    âš ï¸  Äiá»‡n thoáº¡i â€” tháº¥t báº¡i: ${err.message}`); }
  }

  if (masterData.owner_phone_2) {
    console.log(`    â€¢ Số điện thoại thứ 2: ${masterData.owner_phone_2}`);
    try {
      await safeFill(page, SEL_PHONE_2, masterData.owner_phone_2);
      await page.evaluate(`document.activeElement && document.activeElement.blur()`);
      await sleep(200);
    } catch (err) {
      console.warn(`    ⚠️  Số điện thoại thứ 2 — thất bại: ${err.message}`);
    }
  }

  const billingAddress = buildOwnerAddressForBccs(masterData, { useShipCodeAsStreet: true });
  if (hasRequiredBccsAddress(billingAddress, { requireDistrict: true })) {
    try {
      await fillBccsAddressPopup(page, ADDRESS_POPUPS.billing, billingAddress);
    } catch (err) {
      throw new Error(`Dia chi XM/TBC failed: ${err.message}`);
    }
  } else {
    throw new Error("Dia chi XM/TBC missing province/district/precinct/groupStreet.");
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SECTION 5: Há»’ SÆ  ÄÃNH KÃˆM
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

async function fillDocumentSection(page, masterData) {
  console.log(`\n  ðŸ“Ž [BCCS] Cáº­p nháº­t há»“ sÆ¡ Ä‘Ã­nh kÃ¨m...`);
  let uploaded = 0;

  // Chờ panel hồ sơ ổn định trước khi xử lý hàng đầu (BBNT hay bị trượt do vào sớm).
  await sleep(1200);

  for (const slot of DOCUMENT_SLOTS) {
    const filePath = masterData[slot.key];
    if (!filePath) {
      console.log(`    â­ï¸  ${slot.label} â€” khÃ´ng cÃ³ file, bá» qua.`);
      continue;
    }

    // Đuôi ổn định (index + tên component) — miễn nhiễm j_idt tự sinh của prefix.
    const selType = `[id$="${slot.index}:showUploadFileDocdocumentTypeCbx_input"]`;

    try {
      const curType = await page
        .evaluate(`(document.querySelector(${JSON.stringify(selType)}) || {}).value || ''`)
        .catch(() => "");
      if (curType !== slot.type) {
        // Đổi loại làm SFive render lại panel → chờ xong rồi mới đọc ô upload,
        // tránh gán file vào input cũ đã bị thay (nguyên nhân BBNT trượt).
        await page.selectOption(selType, slot.type, { timeout: 8000 });
        await sleep(T.ajax_wait);
      }
    } catch (err) {
      console.warn(`    âš ï¸  ${slot.label} â€” chá»n loáº¡i tháº¥t báº¡i: ${err.message}`);
    }

    try {
      // Tìm id thật của ô upload cùng hàng: lấy prefix từ id thật của ô chọn loại,
      // rồi tìm input[type=file] có id bắt đầu bằng prefix đó (không phụ thuộc j_idt).
      const findFileInputId = () => page.evaluate(`
        (function(typeSel){
          const t = document.querySelector(typeSel);
          if (!t) return null;
          const prefix = t.id.replace(/showUploadFileDocdocumentTypeCbx_input$/, '');
          const f = Array.from(document.querySelectorAll('input[type="file"]'))
            .find(el => el.id && el.id.indexOf(prefix) === 0);
          return f ? f.id : null;
        })(${JSON.stringify(selType)})
      `).catch(() => null);
      // Đọc id ô upload; nếu chưa thấy (panel còn render lại) → chờ rồi đọc lại.
      let fileInputId = await findFileInputId();
      if (!fileInputId) { await sleep(T.ajax_wait); fileInputId = await findFileInputId(); }
      if (!fileInputId) throw new Error("khong tim thay o upload file cua hang nay");
      await page.setInputFiles(`[id="${fileInputId}"]`, filePath);
      await sleep(T.ajax_wait); // chờ auto-upload lên server xong mới sang hàng kế
      console.log(`    âœ… ${slot.label}: ${path.basename(filePath)}`);
      uploaded++;
    } catch (err) {
      console.warn(`    âš ï¸  ${slot.label} â€” upload tháº¥t báº¡i: ${err.message}`);
    }
  }

  console.log(`    ðŸ“Š ÄÃ£ upload: ${uploaded}/${DOCUMENT_SLOTS.length} file.`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CAPTCHA + SUBMIT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// Chụp ảnh captcha trong SFive → base64 data URI (chụp thẳng phần tử, không fetch URL).
async function captureCaptchaImage(page) {
  // SFivePage (CDP) không có .locator() → vẽ ảnh captcha lên canvas rồi lấy dataURL.
  // Ảnh captcha same-origin (/SALE_WEB) nên canvas không bị taint.
  try {
    const dataUri = await page.evaluate(`
      (function(sel){
        const img = document.querySelector(sel);
        if (!img) return null;
        try {
          const w = img.naturalWidth || img.width || 130;
          const h = img.naturalHeight || img.height || 40;
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          return c.toDataURL('image/png');
        } catch (e) { return null; }
      })(${JSON.stringify(SEL_CAPTCHA_IMG)})
    `).catch(() => null);
    if (!dataUri || String(dataUri).indexOf("data:image") !== 0) {
      console.warn(`  ⚠️  Không lấy được ảnh captcha (ảnh chưa tải hoặc canvas lỗi).`);
      return null;
    }
    return dataUri;
  } catch (err) {
    console.warn(`  ⚠️  Không chụp được ảnh captcha: ${err.message}`);
    return null;
  }
}

async function clickReloadCaptcha(page) {
  try { await page.click(".fcapcha", { timeout: 4000 }); }
  catch { try { await safeClick(page, SEL_CAPTCHA_RELOAD, { wait: 300 }); } catch {} }
  await sleep(1200); // chờ ảnh captcha mới render
}

async function typeCaptcha(page, code) {
  await safeFill(page, SEL_CAPTCHA_INPUT, String(code || ""));
}

// Heuristic: BCCS báo "Thông tin mã xác nhận không chính xác" khi captcha sai.
async function isCaptchaWrong(page) {
  return await page.evaluate(`
    (function(){
      const t = (document.body && document.body.innerText) || '';
      return /mã xác nhận không chính xác/i.test(t) || /mã xác nhận là bắt buộc/i.test(t);
    })()
  `).catch(() => false);
}

async function waitConnectSuccess(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(`
      (function(){
        const el = document.querySelector('[id="connectForm:dlgConnectInfor"]');
        return !!el && window.getComputedStyle(el).display !== 'none';
      })()
    `).catch(() => false);
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

// Gọn nội dung lỗi: gộp khoảng trắng, bỏ mã hash tương quan đầu dòng.
// Bắt cả 2 format:
//   "[a64a36cd5ee68a2c] null - [SALE2511] ..." → "[SALE2511] ..."
//   "[fc81d452e35d3c08] Số điện thoại ..."      → "Số điện thoại ..."
function cleanErrorText(s) {
  if (!s) return "";
  let t = String(s).replace(/\s+/g, " ").trim();
  t = t.replace(/^\[[0-9a-f]{6,}\]\s*(null\s*-\s*)?/i, "");
  return t;
}

// Đọc lỗi PrimeFaces SFive hiện khi đấu nối lỗi. Bắt cả 2 dạng:
//   - Message tĩnh: .ui-messages-error-detail / .ui-message-error-detail (vd SALE2511)
//   - Growl (tự ẩn sau vài giây): .ui-growl-item.error (vd "SĐT ... phải là số di động")
// Trả chuỗi lỗi đã gọn (nhiều lỗi nối bằng " | ") hoặc "" nếu không có.
async function readSubmitError(page) {
  const parts = await page.evaluate(`
    (function(){
      var out = [], seen = {};
      function push(t){ t=(t||'').replace(/\\s+/g,' ').trim(); if(t && !seen[t]){ seen[t]=1; out.push(t); } }
      document.querySelectorAll('.ui-messages-error-detail, .ui-message-error-detail')
        .forEach(function(el){ push(el.innerText || el.textContent); });
      document.querySelectorAll('.ui-growl-item.error .ui-growl-message, .ui-growl-item.ui-growl-message-error .ui-growl-message')
        .forEach(function(el){ push(el.innerText || el.textContent); });
      return out;
    })()
  `).catch(() => []);
  const cleaned = (parts || []).map(cleanErrorText).filter(Boolean);
  return [...new Set(cleaned)].join(" | ");
}

// Chờ kết quả đấu nối: hoặc dialog thành công, hoặc lỗi (message/growl) hiện → thoát sớm.
async function waitConnectOutcome(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await page.evaluate(`
      (function(){
        var dlg = document.querySelector('[id="connectForm:dlgConnectInfor"]');
        var okShown = !!dlg && window.getComputedStyle(dlg).display !== 'none';
        var errEl = document.querySelector('.ui-messages-error-detail, .ui-message-error-detail, .ui-growl-item.error .ui-growl-message');
        var errText = errEl ? (errEl.innerText || errEl.textContent || '') : '';
        return { ok: okShown, err: errText };
      })()
    `).catch(() => ({ ok: false, err: "" }));
    if (res.ok) return { ok: true };
    if (res.err && res.err.trim()) {
      const full = await readSubmitError(page);
      return { ok: false, error: full || cleanErrorText(res.err) };
    }
    await sleep(500);
  }
  return { ok: false };
}

// Bàn giao captcha qua giao diện tool: chụp ảnh → chờ nhân viên nhập → điền vào SFive.
// testMode=true: điền captcha vào SFive nhưng KHÔNG bấm Đấu nối (chạy nháp).
// Bàn giao "Địa chỉ hóa đơn cước" để người dùng sửa TRƯỚC captcha.
// billing(currentValue) => Promise<{ value }>. Bỏ trống → dùng cầu nối localhost.
async function handleBillingViaBridge(page, testMode, billing) {
  let current = "";
  try {
    current = await page.evaluate(
      `(document.querySelector(${JSON.stringify(SEL_BILLING_ADDR)}) || {}).value || ''`
    );
  } catch {}
  if (!current) {
    console.log(`  ℹ️  [BCCS] Địa chỉ hóa đơn cước rỗng — bỏ qua bước sửa.`);
    return;
  }
  console.log(`  📤 [BCCS] Bàn giao "Địa chỉ hóa đơn cước" để sửa: "${current}"`);

  const ask =
    billing ||
    (async (v) => {
      const res = await billingBridge.waitForBilling({ value: v, testMode }, 3 * 60 * 1000);
      return { value: res && res.value != null ? res.value : v };
    });

  let res;
  try { res = await ask(current); } catch (e) { console.warn(`  ⚠️  [BCCS] Sửa địa chỉ lỗi: ${e.message}`); return; }
  const finalVal = res && res.value != null ? String(res.value) : current;

  if (finalVal.trim() && finalVal !== current) {
    try {
      await safeFill(page, SEL_BILLING_ADDR, finalVal);
      console.log(`  ✅ [BCCS] Đã điền lại địa chỉ hóa đơn cước đã sửa.`);
    } catch (e) {
      console.warn(`  ⚠️  [BCCS] Điền lại địa chỉ lỗi: ${e.message}`);
    }
  } else {
    console.log(`  ✅ [BCCS] Giữ nguyên địa chỉ hóa đơn cước.`);
  }
}

async function handleCaptchaViaBridge(page, testMode, captcha) {
  console.log(`\n  🔐 [BCCS] Bàn giao captcha qua giao diện tool${testMode ? " (TEST — không bấm Đấu nối)" : ""}...`);
  const DEADLINE = Date.now() + 5 * 60 * 1000; // tổng 5 phút cho cả quá trình
  let round = 0;

  // captcha callback được tiêm từ ngoài (worker remote). Bỏ trống → dùng cầu nối
  // localhost mặc định (khi chạy trực tiếp trên PC): ảnh hiện lên giao diện tool.
  const askCaptcha =
    captcha ||
    (async (image) => {
      const res = await captchaBridge.waitForCaptcha({ image, testMode }, 3 * 60 * 1000);
      return { action: res.type, code: res.code };
    });

  while (Date.now() < DEADLINE) {
    const image = await captureCaptchaImage(page);
    if (!image) return { done: false, submitted: false, reason: "no-image" };

    round += 1;
    const res = await askCaptcha(image, round);

    if (res.action === "timeout" || res.action === "cancel") {
      console.warn(`  ⏱  Kết thúc chờ captcha (${res.action}).`);
      return { done: false, submitted: false, reason: res.action };
    }
    if (res.action === "reload") {
      console.log(`  🔄 Người dùng bấm Đổi mã captcha.`);
      await clickReloadCaptcha(page);
      continue;
    }

    // res.action === 'answer'
    console.log(`  ⌨️  Nhận mã captcha từ giao diện → điền vào SFive.`);
    await typeCaptcha(page, res.code);

    if (testMode) {
      console.log(`  🧪 TEST MODE — đã điền captcha, KHÔNG bấm Đấu nối.`);
      return { done: true, submitted: false, test_mode: true };
    }

    // Bấm Đấu nối
    try { await safeClick(page, SEL_BTN_DAU_NOI, { wait: T.ajax_wait }); }
    catch (err) { console.warn(`  ⚠️  Không bấm được Đấu nối: ${err.message}`); }
    await sleep(1500);

    if (await isCaptchaWrong(page)) {
      console.log(`  ❌ Captcha sai → tự đổi mã, yêu cầu nhập lại.`);
      await clickReloadCaptcha(page);
      continue;
    }

    // Lỗi validate/nghiệp vụ có thể hiện ngay sau Đấu nối (message hoặc growl tự ẩn)
    // → dừng, trả lỗi. Poll vài lần vì growl có thể hiện trễ một chút.
    let earlyErr = "";
    for (let i = 0; i < 6 && !earlyErr; i++) {
      earlyErr = await readSubmitError(page);
      if (!earlyErr) await sleep(400);
    }
    if (earlyErr) {
      console.warn(`  ❌ [BCCS] SFive báo lỗi (sau Đấu nối): ${earlyErr}`);
      return { done: true, submitted: true, failed: true, errorText: earlyErr };
    }

    // Bấm Đồng ý (nếu có dialog xác nhận) rồi chờ dialog kết quả
    try { await safeClick(page, SEL_BTN_DONG_Y, { wait: T.ajax_wait }); } catch {}
    const outcome = await waitConnectOutcome(page, 30000);
    if (outcome.ok) {
      console.log(`  🎉 [BCCS] Đấu nối thành công!`);
      return { done: true, submitted: true };
    }
    if (outcome.error) {
      console.warn(`  ❌ [BCCS] SFive báo lỗi: ${outcome.error}`);
      return { done: true, submitted: true, failed: true, errorText: outcome.error };
    }
    // Không thấy dialog thành công: có thể vẫn sai mã hoặc lỗi khác
    if (await isCaptchaWrong(page)) { await clickReloadCaptcha(page); continue; }
    console.warn(`  ⚠️  Không xác nhận được kết quả đấu nối — kiểm tra trên SFive.`);
    return { done: true, submitted: true, unconfirmed: true };
  }

  return { done: false, submitted: false, reason: "deadline" };
}

async function submitForm(page) {
  console.log(`\n  ðŸš€ [BCCS] Submit â€” Click Äáº¥u ná»‘i...`);
  await safeClick(page, SEL_BTN_DAU_NOI, { wait: T.ajax_wait });

  console.log(`  âœ… [BCCS] Click Äá»“ng Ã½...`);
  await safeClick(page, SEL_BTN_DONG_Y, { wait: T.ajax_wait });

  console.log(`  â³ [BCCS] Chá» dialog káº¿t quáº£ (30s)...`);
  const start = Date.now();
  while (Date.now() - start < 30000) {
    const visible = await page.evaluate(`
      (function() {
        const el = document.querySelector('[id="connectForm:dlgConnectInfor"]');
        if (!el) return false;
        return window.getComputedStyle(el).display !== 'none';
      })()
    `).catch(() => false);
    if (visible) {
      console.log(`  ðŸŽ‰ [BCCS] Äáº¥u ná»‘i thÃ nh cÃ´ng! Dialog káº¿t quáº£ hiá»ƒn thá»‹.`);
      return;
    }
    await sleep(500);
  }
  console.warn(`  âš ï¸  KhÃ´ng xÃ¡c nháº­n Ä‘Æ°á»£c dialog thÃ nh cÃ´ng â€” kiá»ƒm tra thá»§ cÃ´ng.`);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MAIN EXPORT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Launch SFive â†’ Connect CDP â†’ Äiá»n form BCCS.
 * SFive cÃ³ KPI Addon + modifyHeader built-in â†’ pass má»i BCCS security check.
 *
 * @param {object}  masterData
 * @param {boolean} [testMode=false] â€” true: dá»«ng trÆ°á»›c Submit (nháº¥n Enter Ä‘á»ƒ káº¿t thÃºc)
 */
async function runBCCS(masterData, testMode = false, opts = {}) {
  const { captcha = null, billing = null } = opts;
  const startTime = Date.now();
  let cdpClient;
  let keepSFiveOpen = false;

  console.log("\n" + "â•".repeat(60));
  console.log(
    `ðŸ¦Š [BCCS] Báº¯t Ä‘áº§u` +
    (IS_MOCK_TEST ? " ðŸ§ª[MOCK]" : "") +
    (testMode ? " ðŸ§ª[TEST MODE]" : "")
  );
  console.log(`   TÃ u: ${masterData.ship_code}  |  KH: ${masterData.owner_name}`);
  console.log(`   Browser: SFive CDP â€” KPI Addon + modifyHeader built-in âœ…`);
  console.log("â•".repeat(60));

  try {
    // â”€â”€ Launch SFive + Connect CDP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!IS_MOCK_TEST) {
      await launchSFive();
    }
    cdpClient = await connectCDP();

    const page = new SFivePage(cdpClient);
    await page._init();
    console.log(`  âœ… [BCCS] SFive CDP sáºµn sÃ ng.`);
    if (!IS_MOCK_TEST) {
      await dismissChromePopups(page);
    }

    // â”€â”€ Login + Navigate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (IS_MOCK_TEST) {
      const mockUrl = "file://" + path.join(process.cwd(), "bccs-mock.html").replace(/\\/g, "/");
      console.log(`\n  ðŸ§ª [BCCS] MOCK MODE â€” Load: ${mockUrl}`);
      await page.goto(mockUrl);
    } else {
      await login(page);
      await dismissChromePopups(page);
      await navigateToStracking(page);
      await dismissChromePopups(page);
    }

    // â”€â”€ Äiá»n form â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await fillCustomerSection(page, masterData);
    await fillPackageSection(page, masterData);
    await fillSubscriberSection(page, masterData);
    await fillPaymentSection(page, masterData);
    await fillDocumentSection(page, masterData);

    // â”€â”€ Captcha + Submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Bàn giao sửa "Địa chỉ hóa đơn cước" TRƯỚC captcha.
    await handleBillingViaBridge(page, testMode, billing);

    const capResult = await handleCaptchaViaBridge(page, testMode, captcha);
    keepSFiveOpen = !IS_MOCK_TEST;

    const duration = Date.now() - startTime;
    console.log(`\n  ⏱  [BCCS] Hoàn tất luồng trong ${(duration / 1000).toFixed(1)}s.`);
    console.log("â•".repeat(60) + "\n");
    // SFive báo lỗi khi đấu nối (vd nợ cước) → trả success:false để hiện về hub/master form.
    if (capResult.failed && capResult.errorText) {
      return {
        success: false,
        duration_ms: duration,
        test_mode: testMode,
        manual_handoff: false,
        captcha: capResult,
        error: capResult.errorText,
        message: `BCCS lỗi: ${capResult.errorText}`,
      };
    }

    let message;
    if (capResult.submitted) {
      message = capResult.unconfirmed
        ? "BCCS đã bấm Đấu nối nhưng chưa xác nhận được kết quả — kiểm tra trên SFive."
        : "BCCS đấu nối thành công.";
    } else if (capResult.test_mode) {
      message = "TEST MODE — đã điền captcha vào SFive, KHÔNG bấm Đấu nối.";
    } else {
      message = "BCCS đã điền xong nhưng captcha chưa hoàn tất — vui lòng kiểm tra/hoàn tất trên SFive.";
    }

    return {
      success: true,
      duration_ms: duration,
      test_mode: testMode,
      manual_handoff: !capResult.submitted,
      captcha: capResult,
      message,
    };

  } catch (err) {
    console.error(`\n  âŒ [BCCS] Lá»—i: ${err.message}`);
    if (cdpClient) {
      try {
        const page = new SFivePage(cdpClient);
        await screenshotOnError(page, "fatal");
      } catch {}
    }
    const duration = Date.now() - startTime;
    console.log("â•".repeat(60) + "\n");
    throw err;

  } finally {
    if (cdpClient) {
      try { await cdpClient.close(); } catch {}
    }
    if (keepSFiveOpen) {
      console.log(`  🔓 [BCCS] Giữ SFive mở để người dùng hoàn tất thủ công.`);
    } else {
      // ÄÃ³ng SFive sau khi xong
      try {
        execSync("taskkill /f /im sfive.exe", { stdio: "ignore" });
        console.log(`  ðŸ”’ [BCCS] SFive Ä‘Ã£ Ä‘Ã³ng.`);
      } catch {}
    }
  }
}

module.exports = {
  runBCCS,
  __test: {
    ADDRESS_POPUPS,
    fillBccsAddressPopup,
    buildOwnerAddressForBccs,
    splitStreetAndHouseNo,
  },
};
