import { PROVIDER_AUTH } from "@/lib/provider-auth";

const TH =
  "px-4 py-3 text-left font-data text-[10px] text-dim uppercase tracking-[0.16em]";

/**
 * Renders an adapter's required/optional authentication variables as a table.
 * Data comes from `@/lib/provider-auth` so every adapter page stays consistent.
 *
 * Usage in MDX: `<AuthEnv provider="e2b" />`
 */
export const AuthEnv = ({ provider }: { provider: string }) => {
  const auth = PROVIDER_AUTH[provider];
  if (!auth) {
    return null;
  }

  return (
    <div className="not-prose my-6">
      <p className="mb-3 text-muted-foreground text-sm">{auth.summary}</p>

      {auth.vars.length === 0 ? (
        <p className="rounded-xl border border-border bg-muted/30 px-4 py-3 font-mono text-muted-foreground text-sm">
          No credentials required.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[40rem] border-collapse text-sm">
            <caption className="sr-only">
              Authentication variables for the {provider} adapter.
            </caption>
            <thead>
              <tr className="border-border border-b">
                <th className={TH} scope="col">
                  Option
                </th>
                <th className={TH} scope="col">
                  Env var
                </th>
                <th className={TH} scope="col">
                  Required
                </th>
                <th className={TH} scope="col">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {auth.vars.map((v) => (
                <tr className="border-border/60 border-t" key={v.option}>
                  <td className="px-4 py-2.5 align-top">
                    <code className="font-mono text-foreground text-xs">
                      {v.option}
                    </code>
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    {v.env ? (
                      <code className="font-mono text-muted-foreground text-xs">
                        {v.env}
                      </code>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    {v.required ? (
                      <span className="font-medium text-foreground text-xs">
                        required
                      </span>
                    ) : (
                      <span className="text-dim text-xs">optional</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top text-muted-foreground text-xs">
                    {v.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {auth.notes ? <p className="mt-3 text-dim text-xs">{auth.notes}</p> : null}
    </div>
  );
};
