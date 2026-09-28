"use client";

import {
  PLATFORM_SETTINGS,
  SETTING_BY_KEY,
  type SettingDescriptor,
  settingsAnchor,
} from "@gamedashboard/contracts";
import {
  AlertBanner,
  Badge,
  Button,
  FormField,
  Input,
  PageHeader,
  PageTemplate,
  PasswordInput,
  SelectMenu,
  SettingsSection,
  SettingToggle,
} from "@gamedashboard/ui";
import { Settings } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useState, useTransition } from "react";
import { afterSave, afterUpload, openGuard } from "@/lib/brand-image-guard";
import type { PlatformSettings } from "@/server/api/admin";
import {
  savePlatformSettings,
  setFeatureFlag,
  testBilling,
  testDns,
  testSmtp,
} from "@/server/api/admin-actions";
import { BrandImageUpload } from "./brand-image-upload";

/**
 * Réglages de la plateforme.
 *
 * `initial` vaut `null` pour le support : l'API lui refuse la lecture des
 * réglages (identifiants S3, SMTP, annuaire), et l'écran ne lui montre que les
 * sections qu'il peut lire — les presets de sous-utilisateurs —, avec une
 * phrase qui dit pourquoi le reste manque plutôt qu'une page en erreur.
 */
export function AdminSettings({
  initial,
  children,
}: {
  initial: PlatformSettings | null;
  /** Sections qui ont leur propre organisme — les presets de sous-utilisateurs. */
  children?: ReactNode;
}) {
  const t = useTranslations("adminSettings");

  if (initial === null) {
    return (
      <PageTemplate
        header={<PageHeader icon={<Settings />} title={t("title")} subtitle={t("subtitle")} />}
      >
        <AlertBanner variant="info" title={t("reservedTitle")}>
          {t("reservedBody")}
        </AlertBanner>
        {children}
      </PageTemplate>
    );
  }

  return <PlatformSettingsForm initial={initial}>{children}</PlatformSettingsForm>;
}

/**
 * Le formulaire lui-même.
 *
 * Les secrets — mot de passe SMTP, clé S3 — ne sont **jamais relus** : l'API
 * ne renvoie qu'un « configuré ou non ». Le champ est donc toujours vide, et
 * le laisser vide signifie « ne change rien ». Sans cette convention,
 * enregistrer la couleur d'accent effacerait la configuration SMTP.
 */
function PlatformSettingsForm({
  initial,
  children,
}: {
  initial: PlatformSettings;
  children?: ReactNode;
}) {
  const t = useTranslations("adminSettings");
  const tc = useTranslations("common");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [values, setValues] = useState<Record<string, string | number | boolean>>(() =>
    Object.fromEntries(
      initial.values.flatMap((v) => (v.kind === "secret" ? [] : [[v.key, v.value] as const])),
    ),
  );
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  /*
   * « Base » du logo et du favicon : la dernière valeur vue côté serveur.
   * Jointe à l'enregistrement, elle empêche d'écraser une image envoyée depuis
   * un autre onglet, par un autre administrateur, ou encore en vol.
   */
  const [guard, setGuard] = useState(() =>
    openGuard<string>(
      Object.fromEntries(
        initial.values.flatMap((v) =>
          v.kind !== "secret" && SETTING_BY_KEY.get(v.key)?.upload
            ? [[v.key, String(v.value)] as const]
            : [],
        ),
      ),
    ),
  );
  const kept = guard.kept;

  /**
   * Issue du dernier essai d'envoi.
   *
   * Tenu à part du bandeau d'enregistrement : les deux peuvent être vrais en
   * même temps — on enregistre un mot de passe SMTP, puis on éprouve — et
   * écraser l'un par l'autre ferait disparaître la phrase du serveur de
   * courrier, qui est la seule chose exploitable quand l'envoi échoue.
   */
  const [smtpTest, setSmtpTest] = useState<{
    ok: boolean;
    error: string | null;
    sentTo: string | null;
  } | null>(null);

  const runSmtpTest = useCallback(
    () =>
      startTransition(async () => {
        setSmtpTest(null);
        setSmtpTest(await testSmtp());
      }),
    [],
  );

  /** Issue du dernier essai de la liaison avec le facturier, tenue à part pour la même raison. */
  const [billingTest, setBillingTest] = useState<Awaited<ReturnType<typeof testBilling>> | null>(
    null,
  );

  const runBillingTest = useCallback(
    () =>
      startTransition(async () => {
        setBillingTest(null);
        setBillingTest(await testBilling());
      }),
    [],
  );

  /** Issue du dernier essai de la zone DNS des sous-domaines. */
  const [dnsTest, setDnsTest] = useState<Awaited<ReturnType<typeof testDns>> | null>(null);

  const runDnsTest = useCallback(
    () =>
      startTransition(async () => {
        setDnsTest(null);
        setDnsTest(await testDns());
      }),
    [],
  );

  const configured = new Set(
    initial.values.filter((v) => v.kind === "secret" && v.isConfigured).map((v) => v.key),
  );

  const run = useCallback(
    (action: () => Promise<{ error: string | null }>, label: string) =>
      startTransition(async () => {
        const result = await action();
        setError(result.error);
        setSaved(result.error ? null : label);
        if (!result.error) router.refresh();
      }),
    [router],
  );

  /**
   * Enregistre un groupe.
   *
   * Groupe par groupe, et non la page entière : une erreur sur le SMTP ne doit
   * pas empêcher d'enregistrer la marque, et le bouton doit dire ce qu'il
   * enregistre.
   */
  const saveGroup = (settings: readonly SettingDescriptor[], label: string) => {
    const payload: Record<string, string | number | boolean> = {};
    for (const descriptor of settings) {
      if (descriptor.kind === "secret") {
        const typed = secrets[descriptor.key];
        // Vide = inchangé. Le champ ne peut pas être pré-rempli.
        if (typed) payload[descriptor.key] = typed;
        continue;
      }
      payload[descriptor.key] = values[descriptor.key] ?? "";
    }

    const groupBases = Object.fromEntries(
      settings.flatMap((d) => (d.upload ? [[d.key, guard.bases[d.key] ?? ""] as const] : [])),
    );
    const withImages = Object.keys(groupBases).length > 0;

    run(async () => {
      const result = await savePlatformSettings(payload, withImages ? groupBases : undefined);
      if (!result.error) setSecrets({});
      // Recalé sur ce que le serveur a gardé : `useState(initial)` ne suit pas
      // `router.refresh()`, et l'ancienne adresse resterait affichée.
      const images = result.images;
      if (images) setValues((current) => ({ ...current, ...images }));
      if (!result.error) setGuard((current) => afterSave(current, images ?? {}, result.kept));
      return result;
    }, label);
  };

  const field = (descriptor: SettingDescriptor) => {
    if (descriptor.kind === "choice") {
      /*
       * Une liste fermée, et non un champ libre.
       *
       * « Quel système de facturation » décide du comportement du panel : une
       * faute de frappe y produirait une plateforme qui se croit configurée et
       * n'ouvre aucun chemin à ses clients. L'API refuse d'ailleurs toute
       * valeur hors liste — l'écran ne fait que cesser d'en proposer.
       */
      return (
        <FormField
          key={descriptor.key}
          label={descriptor.label}
          description={descriptor.description}
        >
          {(id) => (
            <SelectMenu
              id={id}
              value={String(values[descriptor.key] ?? descriptor.fallback ?? "")}
              onValueChange={(next) =>
                setValues((current) => ({ ...current, [descriptor.key]: next }))
              }
              options={(descriptor.choices ?? []).map((choice) => ({
                value: choice.value,
                label: choice.label,
                description: choice.description,
              }))}
            />
          )}
        </FormField>
      );
    }

    if (descriptor.kind === "boolean") {
      return (
        <SettingToggle
          key={descriptor.key}
          label={descriptor.label}
          description={descriptor.description}
          checked={values[descriptor.key] === true}
          disabled={pending}
          onCheckedChange={(next) => {
            setValues((current) => ({ ...current, [descriptor.key]: next }));
            run(() => savePlatformSettings({ [descriptor.key]: next }), descriptor.label);
          }}
        />
      );
    }

    return (
      <FormField key={descriptor.key} label={descriptor.label} description={descriptor.description}>
        {(id) =>
          descriptor.kind === "secret" ? (
            <div className="flex flex-col gap-1.5">
              <PasswordInput
                id={id}
                value={secrets[descriptor.key] ?? ""}
                onChange={(e) =>
                  setSecrets((current) => ({ ...current, [descriptor.key]: e.target.value }))
                }
                placeholder={
                  configured.has(descriptor.key) ? t("secretUnchanged") : t("secretNotSet")
                }
              />
              {/* Dire qu'un secret est en place sans le montrer : c'est la
                  seule information dont on a besoin pour savoir si l'envoi
                  d'e-mails peut fonctionner. */}
              <span className="text-xs text-muted">
                {configured.has(descriptor.key) ? t("secretStored") : t("secretMissing")}
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <Input
                id={id}
                className={descriptor.kind === "number" ? "gd-mono sm:max-w-xs" : undefined}
                type={descriptor.kind === "number" ? "number" : "text"}
                value={String(values[descriptor.key] ?? "")}
                placeholder={descriptor.placeholder}
                disabled={pending}
                onChange={(e) =>
                  setValues((current) => ({
                    ...current,
                    [descriptor.key]:
                      descriptor.kind === "number" ? Number(e.target.value) : e.target.value,
                  }))
                }
              />
              {/* Logo et favicon : l'adresse, ou un fichier envoyé qui la remplit. */}
              {descriptor.upload ? (
                <BrandImageUpload
                  target="platform"
                  kind={descriptor.upload}
                  disabled={pending}
                  onUploaded={(url) => {
                    // L'API a déjà écrit le réglage : c'est aussi la nouvelle base.
                    setValues((current) => ({ ...current, [descriptor.key]: url }));
                    // Nouvelle base, et bandeau « image gardée » effacé.
                    setGuard((current) => afterUpload(current, descriptor.key, url));
                  }}
                />
              ) : null}
            </div>
          )
        }
      </FormField>
    );
  };

  return (
    <PageTemplate
      header={<PageHeader icon={<Settings />} title={t("title")} subtitle={t("subtitle")} />}
    >
      {error ? (
        <AlertBanner variant="danger" title={t("saveRefused")} dismissible>
          {error}
        </AlertBanner>
      ) : null}
      {saved ? (
        <AlertBanner variant="success" title={tc("saved")} dismissible>
          {saved}
        </AlertBanner>
      ) : null}
      {kept.length > 0 ? (
        <AlertBanner variant="warning" title={t("imagesKeptTitle")} dismissible>
          {t("imagesKeptBody", {
            fields: kept.map((key) => SETTING_BY_KEY.get(key)?.label ?? key).join(", "),
          })}
        </AlertBanner>
      ) : null}

      {PLATFORM_SETTINGS.map((group) => {
        // Les interrupteurs s'enregistrent au clic : leur donner un bouton
        // « Enregistrer » ferait croire qu'on peut les basculer sans effet.
        const hasToggleOnly = group.settings.every((s) => s.kind === "boolean");

        return (
          <SettingsSection
            key={group.key}
            id={settingsAnchor(group.key)}
            title={group.label}
            description={group.description}
            footer={
              hasToggleOnly ? undefined : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button disabled={pending} onClick={() => saveGroup(group.settings, group.label)}>
                    {tc("save")}
                  </Button>
                  {/* Enregistrer ne prouve rien : le panel accepte n'importe
                      quel hôte. L'essai est le seul moment où le serveur de
                      courrier a son mot à dire, et il vaut mieux l'entendre
                      ici qu'à la première demande de mot de passe oublié. */}
                  {group.key === "smtp" ? (
                    <Button variant="secondary" disabled={pending} onClick={runSmtpTest}>
                      {t("smtpTest")}
                    </Button>
                  ) : null}
                  {group.key === "billing" ? (
                    <Button variant="secondary" disabled={pending} onClick={runBillingTest}>
                      {t("billingTest")}
                    </Button>
                  ) : null}
                  {group.key === "dns" ? (
                    <Button variant="secondary" disabled={pending} onClick={runDnsTest}>
                      {t("dnsTest")}
                    </Button>
                  ) : null}
                </div>
              )
            }
          >
            <div
              className={
                hasToggleOnly
                  ? "divide-y divide-border"
                  : "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
              }
            >
              {group.settings.map(field)}
            </div>
            {group.key === "smtp" && smtpTest ? (
              <div className="mt-4">
                <AlertBanner
                  variant={smtpTest.ok ? "success" : "danger"}
                  title={smtpTest.ok ? t("smtpTestOk") : t("smtpTestFailed")}
                  dismissible
                >
                  {smtpTest.ok
                    ? t("smtpTestSent", { email: smtpTest.sentTo ?? "" })
                    : smtpTest.error}
                </AlertBanner>
              </div>
            ) : null}
            {group.key === "billing" && billingTest ? (
              <div className="mt-4">
                <AlertBanner
                  variant={billingTest.ok ? "success" : "danger"}
                  title={billingTest.ok ? t("billingTestOk") : t("billingTestFailed")}
                  dismissible
                >
                  {billingTest.ok
                    ? t(billingTest.knowsCaller ? "billingTestKnown" : "billingTestUnknown")
                    : billingTest.error}
                </AlertBanner>
              </div>
            ) : null}
            {group.key === "dns" && dnsTest ? (
              <div className="mt-4">
                <AlertBanner
                  variant={dnsTest.ok ? "success" : "danger"}
                  title={dnsTest.ok ? t("dnsTestOk") : t("dnsTestFailed")}
                  dismissible
                >
                  {dnsTest.ok ? t("dnsTestZone", { zone: dnsTest.zone ?? "" }) : dnsTest.error}
                </AlertBanner>
              </div>
            ) : null}
          </SettingsSection>
        );
      })}

      <SettingsSection title={t("features")} description={t("featuresHint")}>
        <div className="divide-y divide-border">
          {initial.flags.map((flag) => (
            <SettingToggle
              key={flag.key}
              label={
                <span className="flex items-center gap-2">
                  {flag.label}
                  <Badge variant={flag.enabled ? "success" : "neutral"}>
                    {flag.enabled ? t("featureOn") : t("featureOff")}
                  </Badge>
                </span>
              }
              description={flag.description}
              checked={flag.enabled}
              disabled={pending}
              onCheckedChange={(next) => run(() => setFeatureFlag(flag.key, next), flag.label)}
            />
          ))}
        </div>
      </SettingsSection>

      {children}
    </PageTemplate>
  );
}
