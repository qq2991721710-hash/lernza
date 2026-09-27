import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { I18nProvider } from "@/i18n"
import { queryKeys } from "@/lib/query-keys"
import type { QuestInfo } from "@/lib/contract-types"
import { QuestView } from "./quest"

const contract = vi.hoisted(() => ({
  address: "GOWNER" as string | null,
  getEnrollees: vi.fn<() => Promise<string[]>>(),
  removeEnrollee: vi.fn<() => Promise<void>>(),
}))

vi.mock("@/hooks/use-wallet", () => ({ useWallet: () => ({ address: contract.address }) }))
vi.mock("@/hooks/use-token-metadata", () => ({
  useTokenMetadata: () => ({ metadata: null, isLoading: false, error: null }),
}))
vi.mock("@/lib/env", () => ({ env: { VITE_SOROBAN_NETWORK_PASSPHRASE: "test-network" } }))
vi.mock("@/lib/contracts/config", () => ({
  contractAddresses: {
    quest: "quest-contract",
    milestone: "milestone-contract",
    rewards: "rewards-contract",
  },
}))
vi.mock("@/lib/contracts/quest", () => ({ questClient: contract }))
vi.mock("@/lib/contracts/milestone", () => ({
  milestoneClient: { getOpenDisputes: vi.fn().mockResolvedValue([]) },
}))
vi.mock("@/lib/contracts/rewards", () => ({ rewardsClient: {} }))
vi.mock("@/contexts/notification-context", () => ({
  useNotifications: () => ({ toasts: [], removeToast: vi.fn() }),
}))
vi.mock("@/components/PageMetadata", () => ({ PageMetadata: () => null }))
vi.mock("@/lib/questMetadata", () => ({ buildQuestMetadata: () => ({}) }))
vi.mock("@/components/quest/QuestHeaderPanel", () => ({ QuestHeaderPanel: () => null }))
vi.mock("@/components/quest/MilestonesSection", () => ({ MilestonesSection: () => null }))
vi.mock("@/components/quest/TimelineSection", () => ({ TimelineSection: () => null }))
vi.mock("@/components/quest/BatchClaimResultDialog", () => ({ BatchClaimResultDialog: () => null }))
vi.mock("@/components/analytics/QuestAnalyticsDashboard", () => ({
  QuestAnalyticsDashboard: () => null,
}))
vi.mock("@/components/referral/ReferralCard", () => ({ ReferralCard: () => null }))
vi.mock("@/components/report-quest-dialog", () => ({ ReportQuestDialog: () => null }))
vi.mock("@/components/quest/transfer-ownership-dialog", () => ({
  TransferOwnershipDialog: () => null,
}))
vi.mock("@/lib/contracts/batch-claims", () => ({ batchClaimRewards: vi.fn() }))
vi.mock("@/lib/referrals", () => ({
  storePendingReferral: vi.fn(),
  recordReferralEnrollment: vi.fn(),
}))

const questId = 7
const learner = "GLEARNER"
const otherLearner = "GOTHERLEARNER"
const successMessage = "Learner removed. Verified work and earned rewards remain protected."
const quest: QuestInfo = {
  id: questId,
  owner: "GOWNER",
  name: "Test quest",
  description: "Test description",
  category: "learning",
  tags: [],
  tokenAddr: "token",
  createdAt: 0,
  visibility: 0,
  status: 0,
  deadline: 0,
  verified: false,
}

let queryClient: QueryClient

beforeEach(() => {
  vi.clearAllMocks()
  contract.address = quest.owner
  contract.getEnrollees.mockResolvedValue([otherLearner])
  contract.removeEnrollee.mockResolvedValue(undefined)
  vi.spyOn(window, "confirm").mockReturnValue(true)
  localStorage.setItem("lernza-locale", "en")
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  queryClient.setQueryData(queryKeys.quest(questId), quest)
  queryClient.setQueryData(queryKeys.milestones(questId), [])
  queryClient.setQueryData(queryKeys.enrollees(questId), [learner, otherLearner])
  queryClient.setQueryData(queryKeys.rewardPool(questId), 0n)
  queryClient.setQueryData([...queryKeys.milestones(questId), "reservedReward"], 0n)
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.restoreAllMocks()
})

async function openEnrollees() {
  render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <QuestView questId={questId} onBack={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole("tab", { name: /Enrollees/ }))
  await act(async () => {})
}

describe("QuestView learner removal", () => {
  it("refreshes the scoped enrollee query while preserving the tab, other caches, and visible toast", async () => {
    const otherQuestKey = queryKeys.enrollees(8)
    const otherNetworkKey = ["enrollees", "another-network", "quest-contract", questId]
    queryClient.setQueryData(otherQuestKey, ["another quest learner"])
    queryClient.setQueryData(otherNetworkKey, ["another network learner"])
    await openEnrollees()

    fireEvent.click(screen.getByRole("button", { name: `Remove ${learner}` }))

    await waitFor(() => expect(screen.queryByText(learner)).not.toBeInTheDocument())
    expect(contract.removeEnrollee).toHaveBeenCalledWith(quest.owner, questId, learner)
    expect(contract.getEnrollees).toHaveBeenCalledTimes(1)
    expect(screen.getByText(otherLearner)).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /^Enrollees\s*\(1\)$/ })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    await waitFor(() => expect(screen.getByRole("alert")).not.toHaveClass("opacity-0"))
    expect(screen.getByRole("alert")).toHaveTextContent(successMessage)
    expect(queryClient.getQueryState(otherQuestKey)?.isInvalidated).toBe(false)
    expect(queryClient.getQueryState(otherNetworkKey)?.isInvalidated).toBe(false)
  })

  it("waits for successful removal before refreshing the list or showing success", async () => {
    let finishRemoval!: () => void
    contract.removeEnrollee.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finishRemoval = resolve
        })
    )
    await openEnrollees()
    fireEvent.click(screen.getByRole("button", { name: `Remove ${learner}` }))

    expect(screen.getByText(learner)).toBeInTheDocument()
    expect(screen.queryByText(successMessage)).not.toBeInTheDocument()
    expect(contract.getEnrollees).not.toHaveBeenCalled()

    finishRemoval()
    await waitFor(() => expect(screen.queryByText(learner)).not.toBeInTheDocument())
    expect(screen.getByText(successMessage)).toBeInTheDocument()
  })

  it.each(["RemovalBlockedByPendingApproval", "LeaveBlockedByPendingApproval"])(
    "preserves the learner and reports %s without refreshing",
    async error => {
      contract.removeEnrollee.mockRejectedValueOnce(new Error(error))
      await openEnrollees()
      fireEvent.click(screen.getByRole("button", { name: `Remove ${learner}` }))

      expect(
        await screen.findByText(
          "Removal is blocked while a submission is awaiting review or reward settlement."
        )
      ).toBeInTheDocument()
      expect(screen.getByText(learner)).toBeInTheDocument()
      expect(screen.queryByText(successMessage)).not.toBeInTheDocument()
      expect(contract.getEnrollees).not.toHaveBeenCalled()
    }
  )

  it("does not send a transaction or refresh when confirmation is cancelled", async () => {
    vi.mocked(window.confirm).mockReturnValue(false)
    await openEnrollees()
    fireEvent.click(screen.getByRole("button", { name: `Remove ${learner}` }))

    expect(contract.removeEnrollee).not.toHaveBeenCalled()
    expect(contract.getEnrollees).not.toHaveBeenCalled()
    expect(screen.getByText(learner)).toBeInTheDocument()
  })

  it.each([null, "GNOTOWNER"])("does not expose removal for wallet %s", async address => {
    contract.address = address
    await openEnrollees()

    expect(screen.queryByRole("button", { name: `Remove ${learner}` })).not.toBeInTheDocument()
    expect(contract.removeEnrollee).not.toHaveBeenCalled()
  })
})
