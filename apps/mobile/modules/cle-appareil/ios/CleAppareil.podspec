Pod::Spec.new do |s|
  s.name           = 'CleAppareil'
  s.version        = '1.0.0'
  s.summary        = "Clé d'appareil P-256 de l'application GameDashboard (Secure Enclave)."
  s.description    = "Crée, ouvre et emploie la clé non exportable qui lie le téléphone à un panel (ADR 0010)."
  s.license        = 'UNLICENSED'
  s.author         = 'GameDashboard'
  s.homepage       = 'https://github.com/SysMath/PowerDashboard'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/SysMath/PowerDashboard.git' }
  s.static_framework = true
  s.frameworks     = 'LocalAuthentication', 'Security', 'CryptoKit'

  s.dependency 'ExpoModulesCore'

  s.source_files = "**/*.{h,m,swift}"
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
