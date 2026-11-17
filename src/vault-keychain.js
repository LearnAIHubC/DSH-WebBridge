// Run by macOS JavaScript for Automation, using the system Security framework.
ObjC.import('Foundation')
ObjC.import('Security')

function run(args) {
  if (!['read', 'write', 'delete'].includes(args[0]) || !/^[a-f0-9]{64}$/.test(args[1] || '')) throw new Error('Invalid Keychain operation')
  var constant = function(name) { return ObjC.castRefToObject($[name]) }
  var query = $.NSMutableDictionary.dictionary
  query.setObjectForKey(constant('kSecClassGenericPassword'), constant('kSecClass'))
  query.setObjectForKey($('DSH WebBridge'), constant('kSecAttrService'))
  query.setObjectForKey($(args[1]), constant('kSecAttrAccount'))
  var status
  if (args[0] === 'read') {
    query.setObjectForKey($(true), constant('kSecReturnData'))
    query.setObjectForKey(constant('kSecMatchLimitOne'), constant('kSecMatchLimit'))
    var output = Ref()
    status = $.SecItemCopyMatching(query, output)
    if (status === -25300) return 'null'
    if (status !== 0) throw new Error('Keychain status ' + status)
    return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(ObjC.castRefToObject(output[0]), $.NSUTF8StringEncoding))
  }
  if (args[0] === 'delete') {
    status = $.SecItemDelete(query)
  } else {
    var update = $.NSMutableDictionary.dictionary
    update.setObjectForKey($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, constant('kSecValueData'))
    status = $.SecItemUpdate(query, update)
    if (status === -25300) {
      query.addEntriesFromDictionary(update)
      query.setObjectForKey($('DSH WebBridge tunnel configuration'), constant('kSecAttrLabel'))
      status = $.SecItemAdd(query, Ref())
    }
  }
  if (status !== 0 && !(args[0] === 'delete' && status === -25300)) throw new Error('Keychain status ' + status)
  return 'null'
}
