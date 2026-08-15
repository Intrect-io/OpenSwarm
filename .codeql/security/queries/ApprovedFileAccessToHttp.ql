/**
 * @name File data in outbound network request
 * @description Directly sending file data in an outbound network request can indicate unauthorized information disclosure.
 * @kind path-problem
 * @problem.severity warning
 * @security-severity 6.5
 * @precision medium
 * @id js/file-access-to-http
 * @tags security
 *       external/cwe/cwe-200
 */

import javascript
import semmle.javascript.security.dataflow.FileAccessToHttpCustomizations

/**
 * `prepareApprovedModelRequest` checks an exact HTTPS provider endpoint before
 * encoding a model body. `prepareApprovedLocalModelRequest` admits only a
 * loopback OpenAI-compatible endpoint. `serializeTelemetryPayload`
 * independently projects an object onto the documented telemetry schema. All
 * three are deliberate egress boundaries, not arbitrary outbound file disclosure.
 *
 * A name alone is never sufficient here: a target repository could introduce a
 * function with the same name and thereby suppress a real finding. Bind the
 * sanitizer to CodeQL's statically resolved declaration and its exact shipped
 * source location.
 */
private predicate isApprovedEgressFunction(Function f) {
  (
    f.getName() in ["prepareApprovedModelRequest", "prepareApprovedLocalModelRequest"] and
    f.getFile().getRelativePath() = "src/support/approvedEgress.ts"
  ) or
  (
    f.getName() = "serializeTelemetryPayload" and
    f.getFile().getRelativePath() = "src/telemetry/telemetry.ts"
  )
}

private class ApprovedModelEgressSanitizer extends FileAccessToHttp::Sanitizer {
  ApprovedModelEgressSanitizer() {
    exists(CallExpr call, Function f |
      call.getResolvedCallee() = f and
      isApprovedEgressFunction(f) and
      this.asExpr() = call
    )
  }
}

/**
 * This must be a distinct configuration, rather than a standalone subclass of
 * `FileAccessToHttp::Sanitizer`: the upstream `FileAccessToHttpFlow` is bound
 * to its own configuration at import time. Keeping the sources and sinks
 * identical to the upstream query preserves its coverage while making the
 * three reviewed OpenSwarm egress boundaries real barriers.
 */
private module ApprovedFileAccessToHttpConfig implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node source) { source instanceof FileAccessToHttp::Source }

  predicate isSink(DataFlow::Node sink) { sink instanceof FileAccessToHttp::Sink }

  predicate isBarrier(DataFlow::Node node) {
    node instanceof FileAccessToHttp::Sanitizer or
    node instanceof ApprovedModelEgressSanitizer
  }

  predicate allowImplicitRead(DataFlow::Node node, DataFlow::ContentSet contents) {
    isSink(node) and
    contents = DataFlow::ContentSet::anyProperty()
  }

  predicate observeDiffInformedIncrementalMode() { any() }
}

private module ApprovedFileAccessToHttpFlow = TaintTracking::Global<ApprovedFileAccessToHttpConfig>;

import ApprovedFileAccessToHttpFlow::PathGraph

from ApprovedFileAccessToHttpFlow::PathNode source, ApprovedFileAccessToHttpFlow::PathNode sink
where ApprovedFileAccessToHttpFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "Outbound network request depends on $@.", source.getNode(),
  "file data"
