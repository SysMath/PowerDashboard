package fr.gamedashboard.cleappareil

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Le téléphone doit être déverrouillé (biométrie ou code) avant de signer. */
class CleVerrouilleeException(cause: Throwable?) :
  CodedException("VERROUILLEE : déverrouillez le téléphone pour ouvrir la clé.", cause)

/** La clé de ce panel n'existe pas, ou plus (code du téléphone retiré, données effacées). */
class CleAbsenteException :
  CodedException("CLE_ABSENTE : aucune clé d'appareil pour ce panel.", null)

/**
 * Clé d'appareil P-256 dans le Keystore Android (ADR 0010).
 *
 * StrongBox quand le téléphone en a un, l'environnement d'exécution de
 * confiance sinon ; jamais exportable. La clé ne signe que dans les
 * `FENETRE_S` secondes qui suivent une authentification forte (biométrie de
 * classe 3 ou code du téléphone), demandée par l'application avec
 * expo-local-authentication. Hors de cette fenêtre, `signer` lève
 * `VERROUILLEE` et l'écran redemande.
 */
class CleAppareilModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CleAppareil")

    AsyncFunction("creer") { alias: String -> creer(alias) }

    AsyncFunction("signer") { alias: String, message: String -> signer(alias, message) }

    // L'invite est celle d'expo-local-authentication ; ici, la clé seule.
    AsyncFunction("deverrouiller") { _: String -> true }

    AsyncFunction("signerEnPresence") { alias: String, message: String, _: String ->
      signer(alias, message)
    }

    AsyncFunction("supprimer") { alias: String ->
      val magasin = magasin()
      if (magasin.containsAlias(alias)) magasin.deleteEntry(alias)
    }
  }

  private fun magasin(): KeyStore = KeyStore.getInstance(MAGASIN).apply { load(null) }

  private fun creer(alias: String): String {
    val magasin = magasin()
    if (magasin.containsAlias(alias)) magasin.deleteEntry(alias)

    val strongBox =
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
        appContext.reactContext?.packageManager
          ?.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE) == true
    val paire =
      try {
        generer(alias, strongBox)
      } catch (e: StrongBoxUnavailableException) {
        generer(alias, false)
      }
    // SPKI DER : la forme que le panel garde telle quelle.
    return Base64.encodeToString(paire.public.encoded, Base64.NO_WRAP)
  }

  private fun generer(alias: String, strongBox: Boolean) =
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, MAGASIN).run {
      val spec =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
          .setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        spec.setUserAuthenticationParameters(
          FENETRE_S,
          KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
        )
      } else {
        @Suppress("DEPRECATION") spec.setUserAuthenticationValidityDurationSeconds(FENETRE_S)
      }
      if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) spec.setIsStrongBoxBacked(true)
      initialize(spec.build())
      generateKeyPair()
    }

  private fun signer(alias: String, message: String): String {
    val cle = magasin().getKey(alias, null) as? PrivateKey ?: throw CleAbsenteException()
    try {
      val signature = Signature.getInstance("SHA256withECDSA")
      signature.initSign(cle)
      signature.update(message.toByteArray(Charsets.UTF_8))
      // DER, comme SecKeyCreateSignature sur iOS.
      return Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    } catch (e: UserNotAuthenticatedException) {
      throw CleVerrouilleeException(e)
    } catch (e: KeyPermanentlyInvalidatedException) {
      // Le code du téléphone a été retiré : la clé est perdue pour de bon.
      throw CleAbsenteException()
    }
  }

  companion object {
    private const val MAGASIN = "AndroidKeyStore"

    /** Quinze minutes, la durée d'un jeton d'accès (`FENETRE_DEVERROUILLAGE_S`). */
    private const val FENETRE_S = 15 * 60
  }
}
