# Test-only stand-ins for a platform's two packages (what Fabric-X or Iroha 3 would ship under bundles/bi/bi/platform/<id>
# and bundles/bank/bank/platform/<id>). They live in test/, never in a bundle, and use their own id so a real package of a
# registered platform never merges with them. Each allows only when the test input says so.
package bi.platform.stub

default allow := false

allow if input.stub.bi
