import CryptoKit
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

/// Le téléphone doit être déverrouillé (biométrie ou code) avant de signer.
final class CleVerrouilleeException: Exception {
  override var reason: String { "VERROUILLEE : déverrouillez le téléphone pour ouvrir la clé." }
}

/// La clé de ce panel n'existe pas, ou plus (téléphone restauré, code retiré).
final class CleAbsenteException: Exception {
  override var reason: String { "CLE_ABSENTE : aucune clé d'appareil pour ce panel." }
}

/// La biométrie ou le code a été refusé ou annulé.
final class PresenceRefuseeException: Exception {
  override var reason: String { "PRESENCE_REFUSEE : confirmation annulée." }
}

final class CleCryptoException: GenericException<String> {
  override var reason: String { "Opération de clé refusée : \(param)" }
}

/// Clé d'appareil P-256 dans le Secure Enclave (ADR 0010).
///
/// La clé exige la présence de l'utilisateur (`.userPresence`) : Face ID,
/// Touch ID ou le code du téléphone. Un déverrouillage ouvre un contexte gardé
/// en mémoire quinze minutes, que les renouvellements emploient sans
/// redemander ; un geste lourd demande toujours une confirmation fraîche.
public final class CleAppareilModule: Module {
  private var contexte: LAContext?
  private var ouvertLe: Date?
  private let fenetre: TimeInterval = 15 * 60

  public func definition() -> ModuleDefinition {
    Name("CleAppareil")

    AsyncFunction("creer") { (alias: String) throws -> String in
      self.effacer(alias)
      var erreur: Unmanaged<CFError>?
      let enclave = SecureEnclave.isAvailable
      // `.privateKeyUsage` n'existe que pour une clé du Secure Enclave ; le
      // simulateur, qui n'en a pas, garde une clé logicielle du trousseau.
      let drapeaux: SecAccessControlCreateFlags =
        enclave ? [.privateKeyUsage, .userPresence] : [.userPresence]
      guard
        let controle = SecAccessControlCreateWithFlags(
          kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, drapeaux, &erreur)
      else { throw CleCryptoException(Self.texte(erreur)) }

      var attributs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: Self.etiquette(alias),
          kSecAttrAccessControl as String: controle,
        ] as [String: Any],
      ]
      if enclave { attributs[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }

      guard let privee = SecKeyCreateRandomKey(attributs as CFDictionary, &erreur) else {
        throw CleCryptoException(Self.texte(erreur))
      }
      guard let publique = SecKeyCopyPublicKey(privee),
        let point = SecKeyCopyExternalRepresentation(publique, &erreur) as Data?
      else { throw CleCryptoException(Self.texte(erreur)) }
      // Point brut non compressé (65 octets), que le panel enveloppe en SPKI.
      return point.base64EncodedString()
    }

    AsyncFunction("signer") { (alias: String, message: String) throws -> String in
      guard let contexte = self.contexteOuvert() else { throw CleVerrouilleeException() }
      return try self.signer(alias, message, contexte, invite: false)
    }

    AsyncFunction("deverrouiller") { (raison: String, promesse: Promise) in
      let contexte = LAContext()
      contexte.localizedReason = raison
      contexte.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: raison) { ok, _ in
        if ok {
          self.contexte = contexte
          self.ouvertLe = Date()
        }
        promesse.resolve(ok)
      }
    }

    AsyncFunction("signerEnPresence") {
      (alias: String, message: String, raison: String, promesse: Promise) in
      // Un contexte neuf, jamais celui du déverrouillage : la confirmation
      // d'un geste lourd se donne sur le moment.
      let contexte = LAContext()
      contexte.localizedReason = raison
      contexte.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: raison) { ok, _ in
        guard ok else {
          promesse.reject(PresenceRefuseeException())
          return
        }
        do {
          let signature = try self.signer(alias, message, contexte, invite: true)
          // La présence vient d'être prouvée : elle ouvre aussi la session.
          self.contexte = contexte
          self.ouvertLe = Date()
          promesse.resolve(signature)
        } catch {
          promesse.reject(error)
        }
      }
    }

    AsyncFunction("supprimer") { (alias: String) in
      self.effacer(alias)
    }
  }

  private func contexteOuvert() -> LAContext? {
    guard let contexte = contexte, let ouvert = ouvertLe,
      Date().timeIntervalSince(ouvert) < fenetre
    else {
      contexte?.invalidate()
      contexte = nil
      ouvertLe = nil
      return nil
    }
    return contexte
  }

  private func signer(
    _ alias: String, _ message: String, _ contexte: LAContext, invite: Bool
  ) throws -> String {
    // Jamais d'invite cachée derrière un renouvellement : si le contexte ne
    // suffit plus, l'opération échoue et l'écran demande la biométrie
    // lui-même, en disant pourquoi.
    contexte.interactionNotAllowed = !invite
    let requete: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: Self.etiquette(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
      kSecUseAuthenticationContext as String: contexte,
    ]
    var trouve: CFTypeRef?
    let statut = SecItemCopyMatching(requete as CFDictionary, &trouve)
    guard statut == errSecSuccess, let reference = trouve else {
      if statut == errSecInteractionNotAllowed { throw CleVerrouilleeException() }
      throw CleAbsenteException()
    }
    // swiftlint:disable:next force_cast
    let privee = reference as! SecKey
    var erreur: Unmanaged<CFError>?
    guard
      let signature = SecKeyCreateSignature(
        privee, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &erreur)
        as Data?
    else {
      let code = (erreur?.takeUnretainedValue()).map { CFErrorGetCode($0) } ?? 0
      if code == Int(errSecInteractionNotAllowed) || code == Int(errSecAuthFailed) {
        throw CleVerrouilleeException()
      }
      throw CleCryptoException(Self.texte(erreur))
    }
    return signature.base64EncodedString()
  }

  private func effacer(_ alias: String) {
    let requete: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: Self.etiquette(alias),
    ]
    SecItemDelete(requete as CFDictionary)
  }

  private static func etiquette(_ alias: String) -> Data {
    Data("fr.gamedashboard.cle.\(alias)".utf8)
  }

  private static func texte(_ erreur: Unmanaged<CFError>?) -> String {
    guard let erreur = erreur?.takeRetainedValue() else { return "inconnue" }
    return CFErrorCopyDescription(erreur) as String
  }
}
