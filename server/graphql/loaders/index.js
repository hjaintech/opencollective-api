import Promise from 'bluebird';
import DataLoader from 'dataloader';
import { createContext } from 'dataloader-sequelize';
import { get, groupBy } from 'lodash';
import moment from 'moment';

import orderStatus from '../../constants/order_status';
import { TransactionTypes } from '../../constants/transactions';
import { getBalances, getBalancesWithBlockedFunds } from '../../lib/budget';
import { getFxRate } from '../../lib/currency';
import models, { Op, sequelize } from '../../models';

import collectiveLoaders from './collective';
import commentsLoader from './comments';
import conversationLoaders from './conversation';
import { generateConvertToCurrencyLoader, generateFxRateLoader } from './currency-exchange-rate';
import * as expenseLoaders from './expenses';
import { sortResults, sortResultsSimple } from './helpers';
import { generateAdminUsersEmailsForCollectiveLoader, generateRemoteUserIsAdminOfHostedAccountLoader } from './members';
import { generateCollectivePayoutMethodsLoader, generateCollectivePaypalPayoutMethodsLoader } from './payout-method';
import * as transactionLoaders from './transactions';
import updatesLoader from './updates';
import { generateUserByCollectiveIdLoader } from './user';
import { generateCollectiveVirtualCardLoader, generateHostCollectiveVirtualCardLoader } from './virtual-card';

export const loaders = req => {
  const cache = {};
  const context = createContext(sequelize);

  // Custom helpers
  context.loaders.CurrencyExchangeRate.convert = generateConvertToCurrencyLoader(req, cache);
  context.loaders.CurrencyExchangeRate.fxRate = generateFxRateLoader(req, cache);

  // Comment
  context.loaders.Comment.countByExpenseId = commentsLoader.countByExpenseId(req, cache);

  // Comment Reactions
  context.loaders.Comment.reactionsByCommentId = commentsLoader.reactionsByCommentId(req, cache);
  context.loaders.Comment.remoteUserReactionsByCommentId = commentsLoader.remoteUserReactionsByCommentId(req, cache);

  // Update Reactions
  context.loaders.Update.reactionsByUpdateId = updatesLoader.reactionsByUpdateId(req, cache);
  context.loaders.Update.remoteUserReactionsByUpdateId = updatesLoader.remoteUserReactionsByUpdateId(req, cache);

  // Conversation
  context.loaders.Conversation.followers = conversationLoaders.followers(req, cache);
  context.loaders.Conversation.commentsCount = conversationLoaders.commentsCount(req, cache);

  // Expense
  context.loaders.Expense.activities = expenseLoaders.generateExpenseActivitiesLoader(req, cache);
  context.loaders.Expense.attachedFiles = expenseLoaders.attachedFiles(req, cache);
  context.loaders.Expense.items = expenseLoaders.generateExpenseItemsLoader(req, cache);
  context.loaders.Expense.userTaxFormRequiredBeforePayment = expenseLoaders.userTaxFormRequiredBeforePayment(
    req,
    cache,
  );
  context.loaders.Expense.requiredLegalDocuments = expenseLoaders.requiredLegalDocuments(req, cache);
  context.loaders.Expense.expenseToHostTransactionFxRateLoader =
    expenseLoaders.generateExpenseToHostTransactionFxRateLoader(req, cache);

  // Payout method
  context.loaders.PayoutMethod.paypalByCollectiveId = generateCollectivePaypalPayoutMethodsLoader(req, cache);
  context.loaders.PayoutMethod.byCollectiveId = generateCollectivePayoutMethodsLoader(req, cache);

  // Virtual Card
  context.loaders.VirtualCard.byCollectiveId = generateCollectiveVirtualCardLoader(req, cache);
  context.loaders.VirtualCard.byHostCollectiveId = generateHostCollectiveVirtualCardLoader(req, cache);

  // User
  context.loaders.User.byCollectiveId = generateUserByCollectiveIdLoader(req, cache);

  /** *** Collective *****/

  // Collective - by UserId
  context.loaders.Collective.byUserId = collectiveLoaders.byUserId(req, cache);
  context.loaders.Collective.mainProfileFromIncognito = collectiveLoaders.mainProfileFromIncognito(req, cache);

  // Collective - Host
  context.loaders.Collective.host = new DataLoader(ids =>
    models.Collective.findAll({
      attributes: ['id'],
      where: { id: { [Op.in]: ids } },
      include: [{ model: models.Collective, as: 'host' }],
    }).then(results => {
      const resultsById = {};
      for (const result of results) {
        resultsById[result.id] = result.host;
      }
      return ids.map(id => resultsById[id] || null);
    }),
  );

  // Collective - Balance
  context.loaders.Collective.balance = new DataLoader(ids =>
    getBalances(ids).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
  );
  context.loaders.Collective.balanceWithBlockedFunds = new DataLoader(ids =>
    getBalancesWithBlockedFunds(ids).then(results => sortResults(ids, Object.values(results), 'CollectiveId')),
  );

  // Collective - ConnectedAccounts
  context.loaders.Collective.connectedAccounts = new DataLoader(ids =>
    models.ConnectedAccount.findAll({
      where: { CollectiveId: { [Op.in]: ids } },
    }).then(results => sortResults(ids, results, 'CollectiveId', [])),
  );

  context.loaders.Collective.canSeePrivateInfo = collectiveLoaders.canSeePrivateInfo(req, cache);

  // Collective - Stats
  context.loaders.Collective.stats = {
    backers: new DataLoader(ids => {
      return models.Member.findAll({
        attributes: [
          'CollectiveId',
          'memberCollective.type',
          [sequelize.fn('COALESCE', sequelize.fn('COUNT', '*'), 0), 'count'],
        ],
        where: {
          CollectiveId: { [Op.in]: ids },
          role: 'BACKER',
        },
        include: {
          model: models.Collective,
          as: 'memberCollective',
          attributes: ['type'],
        },
        group: ['CollectiveId', 'memberCollective.type'],
        raw: true,
      })
        .then(rows => {
          const results = groupBy(rows, 'CollectiveId');
          return ids.map(id => {
            const result = get(results, id, []);
            const stats = result.reduce(
              (acc, value) => {
                acc.all += value.count;
                acc[value.type] = value.count;
                return acc;
              },
              { id, all: 0 },
            );
            return {
              CollectiveId: Number(id),
              ...stats,
            };
          });
        })
        .then(results => sortResults(ids, results, 'CollectiveId'));
    }),
    expenses: new DataLoader(ids =>
      models.Expense.findAll({
        attributes: [
          'CollectiveId',
          'status',
          [sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count'],
        ],
        where: { CollectiveId: { [Op.in]: ids } },
        group: ['CollectiveId', 'status'],
      })
        .then(rows => {
          const results = groupBy(rows, 'CollectiveId');
          return Object.keys(results).map(CollectiveId => {
            const stats = {};
            results[CollectiveId].map(e => e.dataValues).map(stat => {
              stats[stat.status] = stat.count;
            });
            return {
              CollectiveId: Number(CollectiveId),
              ...stats,
            };
          });
        })
        .then(results => sortResults(ids, results, 'CollectiveId')),
    ),
    activeRecurringContributions: new DataLoader(ids =>
      models.Order.findAll({
        attributes: [
          'Order.CollectiveId',
          'Order.currency',
          'Subscription.interval',
          [
            sequelize.fn(
              'SUM',
              sequelize.literal(`COALESCE("Order"."totalAmount", 0) - COALESCE("Order"."platformTipAmount", 0)`),
            ),
            'total',
          ],
        ],
        where: {
          CollectiveId: { [Op.in]: ids },
          status: 'ACTIVE',
        },
        group: ['Subscription.interval', 'CollectiveId', 'Order.currency'],
        include: [
          {
            model: models.Subscription,
            attributes: [],
            where: { isActive: true },
          },
        ],
        raw: true,
      }).then(rows => {
        const results = groupBy(rows, 'CollectiveId');
        return Promise.map(ids, async collectiveId => {
          const stats = { CollectiveId: Number(collectiveId), monthly: 0, yearly: 0, currency: null };
          if (results[collectiveId]) {
            for (const result of results[collectiveId]) {
              const interval = result.interval === 'month' ? 'monthly' : 'yearly';
              // If it's the first total collected, set the currency
              if (!stats.currency) {
                stats.currency = result.currency;
              }
              const fxRate = await getFxRate(result.currency, stats.currency);
              stats[interval] += result.total * fxRate;
            }
          }
          return stats;
        });
      }),
    ),
  };

  /** *** Tier *****/
  // Tier - availableQuantity
  context.loaders.Tier.availableQuantity = new DataLoader(tierIds =>
    sequelize
      .query(
        `
          SELECT t.id, (t."maxQuantity" - COALESCE(SUM(o.quantity), 0)) AS "availableQuantity"
          FROM "Tiers" t
          LEFT JOIN "Orders" o ON o."TierId" = t.id AND o."processedAt" IS NOT NULL AND o."status" NOT IN (?)
          WHERE t.id IN (?)
          AND t."maxQuantity" IS NOT NULL
          GROUP BY t.id
        `,
        {
          replacements: [
            [orderStatus.ERROR, orderStatus.CANCELLED, orderStatus.EXPIRED, orderStatus.REJECTED],
            tierIds,
          ],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => {
        return tierIds.map(tierId => {
          const result = results.find(({ id }) => id === tierId);
          if (result) {
            return result.availableQuantity > 0 ? result.availableQuantity : 0;
          } else {
            return null;
          }
        });
      }),
  );
  // Tier - totalDistinctOrders
  context.loaders.Tier.totalDistinctOrders = new DataLoader(ids =>
    models.Order.findAll({
      attributes: [
        'TierId',
        [
          sequelize.fn(
            'COALESCE',
            sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId'))),
            0,
          ),
          'count',
        ],
      ],
      where: { TierId: { [Op.in]: ids } },
      group: ['TierId'],
    }).then(results => sortResults(ids, results, 'TierId').map(result => get(result, 'dataValues.count') || 0)),
  );

  // Tier - totalOrders
  context.loaders.Tier.totalOrders = new DataLoader(ids =>
    models.Order.findAll({
      attributes: ['TierId', [sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count']],
      where: { TierId: { [Op.in]: ids }, processedAt: { [Op.ne]: null } },
      group: ['TierId'],
    }).then(results => sortResults(ids, results, 'TierId').map(result => get(result, 'dataValues.count') || 0)),
  );

  // Tier - totalActiveDistinctOrders
  context.loaders.Tier.totalActiveDistinctOrders = new DataLoader(ids =>
    models.Order.findAll({
      attributes: [
        'TierId',
        [
          sequelize.fn(
            'COALESCE',
            sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId'))),
            0,
          ),
          'count',
        ],
      ],
      where: { TierId: { [Op.in]: ids }, processedAt: { [Op.ne]: null }, status: { [Op.in]: ['ACTIVE', 'PAID'] } },
      group: ['TierId'],
    }).then(results => sortResults(ids, results, 'TierId').map(result => get(result, 'dataValues.count') || 0)),
  );

  // Tier - totalDonated
  context.loaders.Tier.totalDonated = new DataLoader(ids =>
    sequelize
      .query(
        `
        SELECT "Order"."TierId" AS "TierId", COALESCE(SUM("Transaction"."netAmountInCollectiveCurrency"), 0) AS "totalDonated"
        FROM "Transactions" AS "Transaction"
        INNER JOIN "Orders" AS "Order" ON "Transaction"."OrderId" = "Order"."id" AND "Transaction"."CollectiveId" = "Order"."CollectiveId" AND ("Order"."deletedAt" IS NULL)
        WHERE "TierId" IN (?)
        AND "Transaction"."deletedAt" IS NULL
        AND "Transaction"."RefundTransactionId" IS NULL
        AND "Transaction"."type" = 'CREDIT'
        GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.totalDonated : 0))),
  );

  // Tier - totalMonthlyDonations
  context.loaders.Tier.totalMonthlyDonations = new DataLoader(ids =>
    sequelize
      .query(
        `
        SELECT o."TierId" AS "TierId", COALESCE(SUM(s."amount"), 0) AS "total"
        FROM "Orders" o
        INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
        WHERE o."TierId" IN (?)
        AND o."deletedAt" IS NULL
        AND s."isActive" = TRUE
        AND s."interval" = 'month'
        GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.total : 0))),
  );

  // Tier - totalYearlyDonations
  context.loaders.Tier.totalYearlyDonations = new DataLoader(ids =>
    sequelize
      .query(
        `
        SELECT o."TierId" AS "TierId", COALESCE(SUM(s."amount"), 0) AS "total"
        FROM "Orders" o
        INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
        WHERE o."TierId" IN (?)
        AND o."deletedAt" IS NULL
        AND s."isActive" = TRUE
        AND s."interval" = 'year'
        GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.total : 0))),
  );

  // Tier - totalRecurringDonations
  context.loaders.Tier.totalRecurringDonations = new DataLoader(ids => {
    return sequelize
      .query(
        `
          SELECT o."TierId" AS "TierId",
          COALESCE(
            SUM(
              CASE
                WHEN s."interval" = 'year'
                  THEN s."amount"/12
                ELSE s."amount"
              END
            ), 0)
          AS "total"
          FROM "Orders" o
          INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
          WHERE o."TierId" IN (?)
          AND o."deletedAt" IS NULL
          AND s."isActive" = TRUE
          AND s."interval" IN ('year', 'month')
          GROUP BY "TierId";
      `,
        {
          replacements: [ids],
          type: sequelize.QueryTypes.SELECT,
        },
      )
      .then(results => sortResults(ids, results, 'TierId').map(result => (result ? result.total : 0)));
  });

  // Tier - contributorsStats
  context.loaders.Tier.contributorsStats = new DataLoader(tiersIds =>
    models.Member.findAll({
      attributes: [
        'TierId',
        sequelize.col('memberCollective.type'),
        [sequelize.fn('COUNT', sequelize.col('memberCollective.id')), 'count'],
      ],
      where: {
        TierId: { [Op.in]: tiersIds },
      },
      group: ['TierId', sequelize.col('memberCollective.type')],
      include: [
        {
          model: models.Collective,
          as: 'memberCollective',
          attributes: [],
          required: true,
        },
      ],
      raw: true,
    }).then(results => {
      // Used to initialize stats or for when there's no entry available
      const getDefaultStats = TierId => ({
        id: TierId,
        all: 0,
        USER: 0,
        ORGANIZATION: 0,
        COLLECTIVE: 0,
      });

      // Build a map like { 42: { id: 42, users: 12, ... } }
      const resultsMap = {};
      results.forEach(({ TierId, type, count }) => {
        if (!resultsMap[TierId]) {
          resultsMap[TierId] = getDefaultStats(TierId);
        }

        resultsMap[TierId][type] = count;
        resultsMap[TierId].all += count;
      });

      // Return a sorted list to match dataloader format
      return tiersIds.map(tierId => resultsMap[tierId] || getDefaultStats(tierId));
    }),
  );

  /** *** PaymentMethod *****/
  // PaymentMethod - findByCollectiveId
  context.loaders.PaymentMethod.findByCollectiveId = new DataLoader(CollectiveIds =>
    models.PaymentMethod.findAll({
      where: {
        CollectiveId: { [Op.in]: CollectiveIds },
        name: { [Op.ne]: null },
        archivedAt: null,
        expiryDate: {
          [Op.or]: [null, { [Op.gte]: moment().subtract(6, 'month') }],
        },
      },
      order: [['id', 'DESC']],
    }).then(results => sortResults(CollectiveIds, results, 'CollectiveId', [])),
  );

  /** *** Order *****/
  // Order - findByMembership
  context.loaders.Order.findByMembership = new DataLoader(combinedKeys =>
    models.Order.findAll({
      where: {
        CollectiveId: { [Op.in]: combinedKeys.map(k => k.split(':')[0]) },
        FromCollectiveId: {
          [Op.in]: combinedKeys.map(k => k.split(':')[1]),
        },
      },
      order: [['createdAt', 'DESC']],
    }).then(results => sortResults(combinedKeys, results, 'CollectiveId:FromCollectiveId', [])),
  );

  // Order - findPledgedOrdersForCollective
  context.loaders.Order.findPledgedOrdersForCollective = new DataLoader(CollectiveIds =>
    models.Order.findAll({
      where: {
        CollectiveId: { [Op.in]: CollectiveIds },
        status: 'PLEDGED',
      },
      order: [['createdAt', 'DESC']],
    }).then(results => sortResults(CollectiveIds, results, 'CollectiveId', [])),
  );

  // Order - stats
  context.loaders.Order.stats = {
    transactions: new DataLoader(ids =>
      models.Transaction.findAll({
        attributes: ['OrderId', [sequelize.fn('COALESCE', sequelize.fn('COUNT', sequelize.col('id')), 0), 'count']],
        where: { OrderId: { [Op.in]: ids } },
        group: ['OrderId'],
      }).then(results => sortResults(ids, results, 'OrderId').map(result => get(result, 'dataValues.count') || 0)),
    ),
    totalTransactions: new DataLoader(keys =>
      models.Transaction.findAll({
        attributes: ['OrderId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount']],
        where: { OrderId: { [Op.in]: keys } },
        group: ['OrderId'],
      }).then(results =>
        sortResults(keys, results, 'OrderId').map(result => get(result, 'dataValues.totalAmount') || 0),
      ),
    ),
  };

  /** *** Member *****/

  context.loaders.Member.transactions = new DataLoader(combinedKeys =>
    models.Transaction.findAll({
      where: {
        CollectiveId: { [Op.in]: combinedKeys.map(k => k.split(':')[0]) },
        FromCollectiveId: {
          [Op.in]: combinedKeys.map(k => k.split(':')[1]),
        },
      },
      order: [['createdAt', 'DESC']],
    }).then(results => sortResults(combinedKeys, results, 'CollectiveId:FromCollectiveId', [])),
  );

  context.loaders.Member.adminUserEmailsForCollective = generateAdminUsersEmailsForCollectiveLoader();
  context.loaders.Member.remoteUserIdAdminOfHostedAccount = generateRemoteUserIsAdminOfHostedAccountLoader(req);

  /** *** Transaction *****/
  context.loaders.Transaction = {
    ...context.loaders.Transaction,
    byOrderId: new DataLoader(async keys => {
      const where = { OrderId: { [Op.in]: keys } };
      const order = [['createdAt', 'ASC']];
      const transactions = await models.Transaction.findAll({ where, order });
      return sortResults(keys, transactions, 'OrderId', []);
    }),
    directDonationsFromTo: new DataLoader(keys =>
      models.Transaction.findAll({
        attributes: ['FromCollectiveId', 'CollectiveId', [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount']],
        where: {
          FromCollectiveId: { [Op.in]: keys.map(k => k.FromCollectiveId) },
          CollectiveId: { [Op.in]: keys.map(k => k.CollectiveId) },
          type: TransactionTypes.CREDIT,
        },
        group: ['FromCollectiveId', 'CollectiveId'],
      }).then(results => {
        const resultsByKey = {};
        results.forEach(r => {
          resultsByKey[`${r.FromCollectiveId}-${r.CollectiveId}`] = r.dataValues.totalAmount;
        });
        return keys.map(key => {
          return resultsByKey[`${key.FromCollectiveId}-${key.CollectiveId}`] || 0;
        });
      }),
    ),
    totalAmountDonatedFromTo: new DataLoader(keys =>
      models.Transaction.findAll({
        attributes: [
          'FromCollectiveId',
          'UsingGiftCardFromCollectiveId',
          'CollectiveId',
          [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount'],
        ],
        where: {
          [Op.or]: {
            FromCollectiveId: {
              [Op.in]: keys.map(k => k.FromCollectiveId),
            },
            UsingGiftCardFromCollectiveId: {
              [Op.in]: keys.map(k => k.FromCollectiveId),
            },
          },
          CollectiveId: { [Op.in]: keys.map(k => k.CollectiveId) },
          type: TransactionTypes.CREDIT,
          RefundTransactionId: null,
        },
        group: ['FromCollectiveId', 'UsingGiftCardFromCollectiveId', 'CollectiveId'],
      }).then(results => {
        const resultsByKey = {};
        results.forEach(({ CollectiveId, FromCollectiveId, UsingGiftCardFromCollectiveId, dataValues }) => {
          // Credit collective that emitted the gift card (if any)
          if (UsingGiftCardFromCollectiveId) {
            const key = `${UsingGiftCardFromCollectiveId}-${CollectiveId}`;
            const donated = resultsByKey[key] || 0;
            resultsByKey[key] = donated + dataValues.totalAmount;
          }
          // Credit collective who actually made the transaction
          const key = `${FromCollectiveId}-${CollectiveId}`;
          const donated = resultsByKey[key] || 0;
          resultsByKey[key] = donated + dataValues.totalAmount;
        });
        return keys.map(key => {
          return resultsByKey[`${key.FromCollectiveId}-${key.CollectiveId}`] || 0;
        });
      }),
    ),
    hostFeeAmountForTransaction: transactionLoaders.generateHostFeeAmountForTransactionLoader(),
    relatedTransactions: transactionLoaders.generateRelatedTransactionsLoader(),
    balanceById: new DataLoader(async transactionIds => {
      const transactionBalances = await sequelize.query(
        ` SELECT      id, balance
          FROM        "TransactionBalances"
          WHERE       id in (:transactionIds)`,
        {
          type: sequelize.QueryTypes.SELECT,
          replacements: { transactionIds },
        },
      );

      return sortResultsSimple(transactionIds, transactionBalances);
    }),
  };

  return context.loaders;
};

export function loadersMiddleware(req, res, next) {
  req.loaders = loaders(req);
  next();
}
