"use strict";

const assert = require("assert");
const path = require("path");
const { chromium } = require("playwright");
const {
  __test: {
    ADDRESS_POPUPS,
    buildOwnerAddressForBccs,
    fillBccsAddressPopup,
  },
} = require("../automation/bccs-handler");

class PlaywrightCdpLikePage {
  constructor(page) {
    this.page = page;
    this.Input = {
      dispatchKeyEvent: async event => {
        if (event.type === "keyDown") {
          await this.page.keyboard.down(event.key);
        } else if (event.type === "keyUp") {
          await this.page.keyboard.up(event.key);
        }
      },
    };
  }

  async evaluate(expression) {
    return this.page.evaluate(expression);
  }

  async waitForSelector(selector, options = {}) {
    await this.page.waitForSelector(selector, options);
  }

  async click(selector, options = {}) {
    await this.page.click(selector, options);
  }

  async fill(selector, value, options = {}) {
    await this.page.waitForSelector(selector, { timeout: options.timeout ?? 10000 });
    await this.page.fill(selector, String(value ?? ""));
  }

  async typeSlowly(selector, text, options = {}) {
    await this.page.waitForSelector(selector, { timeout: options.timeout ?? 10000 });
    await this.page.fill(selector, "");
    await this.page.type(selector, String(text ?? ""), { delay: options.delay ?? 50 });
  }
}

async function installBccsAddressHarness(page) {
  await page.evaluate(() => {
    const popupConfigs = [
      {
        dialog: ".atxtDeploymentAddressSipdlgLocation",
        openFunction: "reload_txtDeploymentAddressSip_location",
        saveButton: ".txtDeploymentAddressSipbtnSumitLocation",
        displayInput: "connectForm:j_idt1724:input_for_address_txtDeploymentAddressSip_txt2",
        province: "connectForm:j_idt1724:txtDeploymentAddressSipprovince_input",
        district: "connectForm:j_idt1724:txtDeploymentAddressSipdistrict_input",
        precinct: "connectForm:j_idt1724:txtDeploymentAddressSipprecinct_input",
        groupStreet: "connectForm:j_idt1724:txtDeploymentAddressSipgroupStreet_input",
        street: "connectForm:j_idt1724:txtDeploymentAddressSipstreetPro",
        noApartment: "connectForm:j_idt1724:txtDeploymentAddressSipnoApartment",
      },
      {
        dialog: ".aj_idt1904txtAccAddressXmttdlgLocation",
        openFunction: "reload_j_idt1904txtAccAddressXmtt_location",
        saveButton: ".j_idt1904txtAccAddressXmttbtnSumitLocation",
        displayInput: "connectForm:j_idt1904:svAccountInfo:j_idt2749:input_for_address_j_idt1904txtAccAddressXmtt_txt2",
        province: "connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttprovince_input",
        district: "connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttdistrict_input",
        precinct: "connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttprecinct_input",
        groupStreet: "connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttgroupStreet_input",
        street: "connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttstreetPro",
        noApartment: "connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttnoApartment",
      },
    ];

    const show = el => {
      if (!el) return;
      el.style.display = "block";
      el.style.visibility = "visible";
      el.style.left = "20px";
      el.style.top = "20px";
      el.setAttribute("aria-hidden", "false");
      el.classList.remove("ui-helper-hidden", "ui-hidden-container");
    };

    const hide = el => {
      if (!el) return;
      el.style.display = "none";
      el.setAttribute("aria-hidden", "true");
    };

    const setValue = (el, value) => {
      if (!el) return;
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    const optionTextFor = input => {
      const value = input.value.trim();
      if (input.id.includes("province")) return `C780 - ${value || "CA MAU"}`;
      if (input.id.includes("district")) return `D001 - ${value || "HUYEN TEST"}`;
      if (input.id.includes("precinct")) return `P001 - ${value || "XA TEST"}`;
      if (input.id.includes("groupStreet")) return `G001 - ${value || "TO TEST"}`;
      return value || "OPTION TEST";
    };

    const showAutocomplete = input => {
      const panel = document.getElementById(input.id.replace(/_input$/, "_panel"));
      if (!panel) return;
      panel.innerHTML = "";
      panel.classList.remove("ui-helper-hidden");
      panel.style.display = "block";
      panel.style.visibility = "visible";
      panel.style.position = "absolute";
      panel.style.zIndex = "9999";

      const item = document.createElement("li");
      item.className = "ui-autocomplete-item ui-widget-content";
      item.textContent = optionTextFor(input);
      item.addEventListener("click", event => {
        event.preventDefault();
        setValue(input, input.value.trim().toUpperCase());
        panel.style.display = "none";
      });
      panel.appendChild(item);
    };

    window.$ = window.$ || function jqueryLite(selectorOrFn) {
      if (typeof selectorOrFn === "function") {
        selectorOrFn();
        return;
      }
      const nodes = Array.from(document.querySelectorAll(selectorOrFn));
      return {
        val(value) {
          if (value === undefined) return nodes[0]?.value ?? "";
          nodes.forEach(node => setValue(node, value));
          return this;
        },
        focus() {
          nodes[0]?.focus();
          return this;
        },
      };
    };

    window.PrimeFaces = window.PrimeFaces || {};
    window.PrimeFaces.ab = cfg => {
      if (cfg?.onco) cfg.onco(null, "success", { validationFailed: false });
    };
    window.PrimeFaces.focus = () => {};

    window.PF = name => ({
      activate() {},
      deactivate() {},
      show() {
        show(document.querySelector(`.${name}`));
      },
      hide() {
        hide(document.querySelector(`.${name}`));
      },
      search() {
        const input = document.querySelector(`[id$="${name}_input"]`);
        if (input) showAutocomplete(input);
      },
    });

    for (const config of popupConfigs) {
      window[config.openFunction] = () => {
        show(document.querySelector(config.dialog));
      };
    }

    document.addEventListener("keyup", event => {
      if (event.keyCode !== 120) return;
      const input = document.activeElement;
      if (input?.classList?.contains("ui-autocomplete-input")) {
        showAutocomplete(input);
      }
    }, true);

    document.addEventListener("click", event => {
      const config = popupConfigs.find(item => event.target.closest(item.saveButton));
      const saveButton = config && event.target.closest(config.saveButton);
      if (!saveButton) return;

      event.preventDefault();
      event.stopImmediatePropagation();

      const province = document.getElementById(config.province)?.value;
      const district = document.getElementById(config.district)?.value;
      const precinct = document.getElementById(config.precinct)?.value;
      const groupStreet = document.getElementById(config.groupStreet)?.value;
      const street = document.getElementById(config.street)?.value;
      const noApartment = document.getElementById(config.noApartment)?.value;
      const display = [noApartment, street, groupStreet, precinct, district, province]
        .filter(Boolean)
        .join(", ");

      setValue(
        document.getElementById(config.displayInput),
        display
      );
      hide(document.querySelector(config.dialog));
    }, true);
  });
}

async function main() {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
  const page = await browser.newPage();

  try {
    const mockUrl = `file://${path.join(process.cwd(), "bccs-mock.html").replace(/\\/g, "/")}`;
    await page.goto(mockUrl);
    await installBccsAddressHarness(page);

    const adapter = new PlaywrightCdpLikePage(page);
    const masterData = {
      owner_address_province: "Ca Mau",
      owner_address_district: "Ngoc Hien",
      owner_address_precinct: "Tan An",
      owner_address_group_street: "Ap 1",
      owner_address_street: "54 Nguyen Binh Khiem",
    };
    const address = buildOwnerAddressForBccs(masterData);

    assert.deepStrictEqual(address, {
      province: "Ca Mau",
      district: "Ngoc Hien",
      precinct: "Tan An",
      groupStreet: "Ap 1",
      street: "Nguyen Binh Khiem",
      noApartment: "54",
    });

    await fillBccsAddressPopup(adapter, ADDRESS_POPUPS.install, address);

    const values = await page.evaluate(() => ({
      province: document.getElementById("connectForm:j_idt1724:txtDeploymentAddressSipprovince_input")?.value,
      district: document.getElementById("connectForm:j_idt1724:txtDeploymentAddressSipdistrict_input")?.value,
      precinct: document.getElementById("connectForm:j_idt1724:txtDeploymentAddressSipprecinct_input")?.value,
      groupStreet: document.getElementById("connectForm:j_idt1724:txtDeploymentAddressSipgroupStreet_input")?.value,
      street: document.getElementById("connectForm:j_idt1724:txtDeploymentAddressSipstreetPro")?.value,
      noApartment: document.getElementById("connectForm:j_idt1724:txtDeploymentAddressSipnoApartment")?.value,
      displayAddress: document.getElementById("connectForm:j_idt1724:input_for_address_txtDeploymentAddressSip_txt2")?.value,
      dialogHidden: document.querySelector(".atxtDeploymentAddressSipdlgLocation")?.getAttribute("aria-hidden"),
    }));

    assert.strictEqual(values.province, "CA MAU");
    assert.strictEqual(values.district, "NGOC HIEN");
    assert.strictEqual(values.precinct, "TAN AN");
    assert.strictEqual(values.groupStreet, "AP 1");
    assert.strictEqual(values.street, "");
    assert.strictEqual(values.noApartment, "");
    assert.strictEqual(values.dialogHidden, "true");
    assert.match(values.displayAddress, /AP 1, TAN AN, NGOC HIEN, CA MAU/);

    const billingAddress = buildOwnerAddressForBccs(
      { ...masterData, ship_code: "BV-3995-TS" },
      { useShipCodeAsStreet: true }
    );
    await fillBccsAddressPopup(adapter, ADDRESS_POPUPS.billing, billingAddress);

    const billingValues = await page.evaluate(() => ({
      province: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttprovince_input")?.value,
      district: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttdistrict_input")?.value,
      precinct: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttprecinct_input")?.value,
      groupStreet: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttgroupStreet_input")?.value,
      street: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttstreetPro")?.value,
      noApartment: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:j_idt1904txtAccAddressXmttnoApartment")?.value,
      displayAddress: document.getElementById("connectForm:j_idt1904:svAccountInfo:j_idt2749:input_for_address_j_idt1904txtAccAddressXmtt_txt2")?.value,
      dialogHidden: document.querySelector(".aj_idt1904txtAccAddressXmttdlgLocation")?.getAttribute("aria-hidden"),
    }));

    assert.strictEqual(billingValues.province, "CA MAU");
    assert.strictEqual(billingValues.district, "NGOC HIEN");
    assert.strictEqual(billingValues.precinct, "TAN AN");
    assert.strictEqual(billingValues.groupStreet, "AP 1");
    assert.strictEqual(billingValues.street, "BV-3995-TS");
    assert.strictEqual(billingValues.noApartment, "");
    assert.strictEqual(billingValues.dialogHidden, "true");
    assert.match(billingValues.displayAddress, /BV-3995-TS, AP 1, TAN AN, NGOC HIEN, CA MAU/);

    console.log("BCCS address popup tests passed.");
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
